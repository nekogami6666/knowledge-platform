import { describe, expect, it } from "vitest";
import {
  createAskLifecycle,
  createShutdownHandler,
  DEFAULT_ABORT_SETTLE_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  INTERACTION_DEADLINE_MARGIN_MS,
  INTERACTION_TOKEN_MS,
  interactionLikelyExpired,
  interactionTokenUsable,
  recoverInterruptedAsks,
  safeErrorInfo,
} from "./ask-lifecycle.js";
import { createMemoryStore, type InflightAsk } from "./db.js";

/** 手動で進める fake タイマ(ms 指定の登録を now に応じて発火する)。 */
function manualTimers(): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    advance: (ms) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const flush = () => new Promise((res) => setTimeout(res, 0));

function counterId(): () => string {
  let n = 0;
  return () => `t${++n}`;
}

const input = (n: number) => ({
  applicationId: "app",
  token: `secret-token-${n}`,
  correlationId: `corr-${n}`,
  acceptedAtMs: 1000 * n,
});

describe("期限の判定(ADR-0035 D2 / 追記)", () => {
  it("全体期限は受付 + 15 分 − 余裕 1 分。ちょうどは期限内・超えたら期限切れ", () => {
    const limit = INTERACTION_TOKEN_MS - INTERACTION_DEADLINE_MARGIN_MS;
    expect(limit).toBe(14 * 60_000);
    expect(interactionLikelyExpired(0, limit)).toBe(false);
    expect(interactionLikelyExpired(0, limit + 1)).toBe(true);
  });

  it("token は受付から 15 分未満なら使える", () => {
    expect(interactionTokenUsable(0, INTERACTION_TOKEN_MS - 1)).toBe(true);
    expect(interactionTokenUsable(0, INTERACTION_TOKEN_MS)).toBe(false);
  });

  it("既定の猶予 60 秒 + 後処理 15 秒は compose の stop_grace_period(90 秒)に収まる", () => {
    expect(DEFAULT_SHUTDOWN_GRACE_MS + DEFAULT_ABORT_SETTLE_MS).toBeLessThan(90_000);
  });
});

describe("createAskLifecycle", () => {
  it("begin で inflight_asks に記録し、finish で即削除する(冪等)", () => {
    const store = createMemoryStore();
    const lc = createAskLifecycle({ store, newId: counterId() });
    const t = lc.begin(input(1));
    expect(t).not.toBeNull();
    expect(store.listInflightAsks()).toEqual([{ id: "t1", ...input(1) }]);
    expect(lc.inflight).toBe(1);
    t?.finish();
    t?.finish();
    expect(store.listInflightAsks()).toEqual([]);
    expect(lc.inflight).toBe(0);
  });

  it("記録に失敗しても受付は続け、警告に token を含めない", () => {
    const warns: Record<string, unknown>[] = [];
    const store = createMemoryStore();
    store.addInflightAsk = () => {
      throw new Error("db locked secret-token-1");
    };
    const lc = createAskLifecycle({
      store,
      newId: counterId(),
      log: { info: () => {}, warn: (d) => warns.push(d) },
    });
    expect(lc.begin(input(1))).not.toBeNull();
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toContain("secret-token-1");
  });

  it("shutdown: 受付を止め(begin は null)、処理中が猶予内に終われば中断しない", async () => {
    const timers = manualTimers();
    const lc = createAskLifecycle({ newId: counterId(), ...timers });
    const t = lc.begin(input(1));
    const done = lc.shutdown();
    expect(lc.accepting).toBe(false);
    expect(lc.begin(input(2))).toBeNull();
    timers.advance(30_000);
    t?.finish();
    await expect(done).resolves.toEqual({
      inflightAtStart: 1,
      drained: true,
      aborted: 0,
      unsettled: 0,
    });
    expect(t?.signal.aborted).toBe(false);
    expect(timers.pending()).toBe(0); // 猶予タイマを残さない
  });

  it("shutdown: 猶予を超えたら全件 abort し、後処理が終わるのを待つ", async () => {
    const timers = manualTimers();
    const lc = createAskLifecycle({
      newId: counterId(),
      graceMs: 60_000,
      abortSettleMs: 15_000,
      ...timers,
    });
    const a = lc.begin(input(1));
    const b = lc.begin(input(2)); // 順番待ち相当
    // 中断されたら各自が後処理(通知・記録)をしてから finish する。
    for (const t of [a, b])
      t?.signal.addEventListener("abort", () => setTimeout(() => t.finish(), 0));
    const done = lc.shutdown();
    timers.advance(59_999);
    await flush();
    expect(a?.signal.aborted).toBe(false);
    timers.advance(1);
    await flush();
    expect(a?.signal.aborted).toBe(true);
    expect(b?.signal.aborted).toBe(true);
    await expect(done).resolves.toEqual({
      inflightAtStart: 2,
      drained: false,
      aborted: 2,
      unsettled: 0,
    });
    expect(timers.pending()).toBe(0);
  });

  it("shutdown: 中断後も終わらない件は unsettled として返す(行は残り次回起動時に書き換える)", async () => {
    const timers = manualTimers();
    const store = createMemoryStore();
    const lc = createAskLifecycle({
      store,
      newId: counterId(),
      graceMs: 10,
      abortSettleMs: 5,
      ...timers,
    });
    lc.begin(input(1));
    const done = lc.shutdown();
    timers.advance(10);
    await flush();
    timers.advance(5);
    await expect(done).resolves.toMatchObject({ aborted: 1, unsettled: 1 });
    expect(store.listInflightAsks()).toHaveLength(1);
  });

  it("shutdown は 2 回呼んでも同じ Promise・処理中が無ければ即完了", async () => {
    const lc = createAskLifecycle({ newId: counterId() });
    const p1 = lc.shutdown();
    expect(lc.shutdown()).toBe(p1);
    await expect(p1).resolves.toEqual({
      inflightAtStart: 0,
      drained: true,
      aborted: 0,
      unsettled: 0,
    });
  });
});

describe("createShutdownHandler", () => {
  it("stopTimers が Promise を返したら(事前起動した subprocess の破棄・ADR-0042)待ってから切断する", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const handler = createShutdownHandler({
      lifecycle: {
        shutdown: async () => ({ inflightAtStart: 0, drained: true, aborted: 0, unsettled: 0 }),
      },
      stopTimers: () =>
        new Promise<void>((res) => {
          order.push("timers");
          release = () => {
            order.push("prewarm-disposed");
            res();
          };
        }),
      destroyClient: async () => {
        order.push("discord");
      },
      closeStore: () => order.push("db"),
      exit: (code) => order.push(`exit:${code}`),
      log: { info: () => {}, warn: () => {} },
    });
    const p = handler("SIGTERM");
    await flush();
    expect(order).toEqual(["timers"]);
    release();
    await p;
    expect(order).toEqual(["timers", "prewarm-disposed", "discord", "db", "exit:0"]);
  });

  it("/ask の終了処理 → タイマ解除 → Discord 切断 → DB を閉じる → exit(0) の順・2 回目のシグナルは無視", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const handler = createShutdownHandler({
      lifecycle: {
        shutdown: () =>
          new Promise((res) => {
            order.push("asks");
            release = () => res({ inflightAtStart: 0, drained: true, aborted: 0, unsettled: 0 });
          }),
      },
      stopTimers: () => order.push("timers"),
      destroyClient: async () => {
        order.push("discord");
      },
      closeStore: () => order.push("db"),
      exit: (code) => order.push(`exit:${code}`),
      log: { info: () => {}, warn: () => {} },
    });
    const p = handler("SIGTERM");
    const p2 = handler("SIGINT");
    expect(p2).toBe(p);
    await flush();
    expect(order).toEqual(["asks"]); // 待機中は切断しない
    release();
    await p;
    expect(order).toEqual(["asks", "timers", "discord", "db", "exit:0"]);
  });

  it("途中の失敗は warn にして後段を続け、必ず exit(0) する", async () => {
    const exits: number[] = [];
    const warns: Record<string, unknown>[] = [];
    let closed = false;
    const handler = createShutdownHandler({
      lifecycle: {
        shutdown: async () => ({ inflightAtStart: 0, drained: true, aborted: 0, unsettled: 0 }),
      },
      destroyClient: async () => {
        throw new Error("ws closed");
      },
      closeStore: () => {
        closed = true;
      },
      exit: (c) => exits.push(c),
      log: { info: () => {}, warn: (d) => warns.push(d) },
    });
    await handler("SIGTERM");
    expect(closed).toBe(true);
    expect(exits).toEqual([0]);
    expect(warns[0]).toMatchObject({ step: "discord" });
  });
});

describe("recoverInterruptedAsks(強制終了からの後始末)", () => {
  const row = (id: string, acceptedAtMs: number): InflightAsk => ({
    id,
    applicationId: "app",
    token: `secret-${id}`,
    acceptedAtMs,
    correlationId: `corr-${id}`,
  });

  it("15 分以内の行だけ元の応答を書き換え、読んだ行はすべて id 単位で削除する(新しい行は残す)", async () => {
    const store = createMemoryStore();
    const now = 10 * 60 * 60_000;
    const recent = row("recent", now - 5 * 60_000);
    const old = row("old", now - INTERACTION_TOKEN_MS);
    for (const r of [recent, old]) store.addInflightAsk(r);
    const rows = store.listInflightAsks();
    // 起動直後に受け付けた新しい /ask の行(後始末の対象外)。
    store.addInflightAsk(row("new", now));
    const edits: [string, string, string][] = [];
    const res = await recoverInterruptedAsks({
      rows,
      store,
      nowMs: () => now,
      editOriginal: async (a, t, c) => {
        edits.push([a, t, c]);
      },
      content: "中断しました",
      log: { info: () => {}, warn: () => {} },
    });
    expect(edits).toEqual([["app", "secret-recent", "中断しました"]]);
    expect(res).toEqual({ edited: 1, failed: 0, expired: 1 });
    expect(store.listInflightAsks().map((r) => r.id)).toEqual(["new"]);
  });

  it("書き換えに失敗しても行は削除し、警告に token や URL を出さない", async () => {
    const store = createMemoryStore();
    const r = row("x", 0);
    store.addInflightAsk(r);
    const warns: Record<string, unknown>[] = [];
    const err = Object.assign(new Error("Invalid Webhook Token"), {
      code: 50027,
      status: 401,
      url: "https://discord.com/api/v10/webhooks/app/secret-x/messages/@original",
    });
    const res = await recoverInterruptedAsks({
      rows: [r],
      store,
      nowMs: () => 1000,
      editOriginal: async () => {
        throw err;
      },
      content: "中断しました",
      log: { info: () => {}, warn: (d) => warns.push(d) },
    });
    expect(res.failed).toBe(1);
    expect(store.listInflightAsks()).toEqual([]);
    expect(warns[0]).toMatchObject({ correlationId: "corr-x", err: { code: 50027, status: 401 } });
    expect(JSON.stringify(warns)).not.toContain("secret-x");
  });

  it("safeErrorInfo は name/code/status だけを返す", () => {
    expect(safeErrorInfo(Object.assign(new Error("m"), { code: 1, url: "u" }))).toEqual({
      name: "Error",
      code: 1,
    });
    expect(safeErrorInfo("x")).toEqual({ error: "string" });
  });
});
