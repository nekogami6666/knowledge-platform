import { describe, expect, it } from "vitest";
import { createAskBackgroundSync } from "./ask-background-sync.js";
import { SerialQueue } from "./concurrency.js";
import { createRepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";
import type { RepoSpec, RepoSyncer, RepoSyncResult, SyncedRepo } from "./repos.js";

const kb: ScopedRepo = { repo: "org/kb", dir: "kb", syncOnAsk: true, managed: false };
const minutes: ScopedRepo = {
  repo: "org/minutes",
  dir: "minutes",
  syncOnAsk: true,
  managed: false,
};
const code: ScopedRepo = { repo: "org/app", dir: "app", syncOnAsk: false, managed: true };
const sr = (r: RepoSpec, sha: string): SyncedRepo => ({
  repo: r.repo,
  absDir: `/clones/${r.dir}`,
  resolvedCommit: sha,
});
const TTL = 60_000;
const INTERVAL = 45_000;

function harness(opts: { fail?: string[] } = {}) {
  const fail = new Set(opts.fail);
  const synced: string[][] = [];
  const syncer: RepoSyncer = {
    sync: async () => {
      throw new Error("使わない");
    },
    syncEach: async (specs) => {
      synced.push(specs.map((s) => s.repo));
      return specs.map(
        (spec): RepoSyncResult =>
          fail.has(spec.repo)
            ? { status: "failed", spec, error: new Error(`fetch failed ${spec.repo}`) }
            : { status: "synced", spec, synced: sr(spec, `sha-${spec.dir}`) },
      );
    },
    resolveHead: async () => null,
    inspect: async () => null,
    restoreHead: async () => null,
    fetchTimeOnDisk: async () => null,
  };
  const registry = createRepoRegistry([kb, minutes, code]);
  const queue = new SerialQueue();
  const clock = { now: 1_000_000 };
  const warns: Record<string, unknown>[] = [];
  let stopped = false;
  const bg = createAskBackgroundSync({
    registry,
    syncer,
    isQueueIdle: () => queue.pending === 0,
    enqueueLow: (task) => queue.enqueue(task, { priority: "low" }),
    ttlMs: TTL,
    isStopped: () => stopped,
    nowMs: () => clock.now,
    logger: { info: () => {}, warn: (data) => warns.push(data) },
  });
  return {
    bg,
    registry,
    queue,
    clock,
    synced,
    warns,
    fail,
    stop: () => {
      stopped = true;
    },
  };
}

describe("createAskBackgroundSync(/ask の先回り同期・ADR-0035 追記 2026-10-08)", () => {
  it("キューが空なら sync_on_ask のリポだけを同期し、RepoRegistry に最終成功同期として記録する", async () => {
    const h = harness();
    expect(await h.bg.tick(INTERVAL)).toEqual({ kind: "ran", synced: 2, failed: 0 });
    expect(h.synced).toEqual([["org/kb", "org/minutes"]]); // sync_on_ask 外(org/app)は対象外
    expect(h.registry.lastFetchedAt("org/kb")).toBe(h.clock.now);
    expect(h.registry.lastSynced("org/minutes")?.resolvedCommit).toBe("sha-minutes");
  });

  it("キューに実行中・待機中のタスクがあれば積まない(/ask を待たせない)", async () => {
    const h = harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ask = h.queue.enqueue(() => gate);
    expect(await h.bg.tick(INTERVAL)).toEqual({ kind: "queue_busy" });
    expect(h.synced).toEqual([]);
    release();
    await ask;
    expect((await h.bg.tick(INTERVAL)).kind).toBe("ran");
  });

  it("取り出し済みの先回り同期は /ask が来ても中断せず、その完了後に /ask を実行する", async () => {
    const h = harness();
    const order: string[] = [];
    // 先回り同期を積んだ直後に /ask が来る(キューは空だったので同期は既に取り出されている)。
    const tick = h.bg.tick(INTERVAL);
    const ask = h.queue.enqueue(async () => void order.push(`ask:${h.synced.length}`));
    await Promise.all([tick, ask]);
    expect(order).toEqual(["ask:1"]); // 実行中の同期は中断せず、その後に /ask
  });

  it("前回の分が終わっていなければ重ねない", async () => {
    const h = harness();
    const first = h.bg.tick(INTERVAL);
    expect(await h.bg.tick(INTERVAL)).toEqual({ kind: "busy" });
    await first;
  });

  it("次の周期までに TTL を過ぎないリポは省き、無効化されたリポは常に同期する", async () => {
    const h = harness();
    await h.bg.tick(INTERVAL);
    // 直後(/ask が同期した直後に相当): 次の周期(45 秒後)でも TTL(60 秒)内なので省く。
    h.clock.now += 10_000;
    expect(await h.bg.tick(INTERVAL)).toEqual({ kind: "ran", synced: 0, failed: 0 });
    // 鮮度確認の KB 書き込みで無効化されたリポは TTL 内でも同期する。
    h.registry.invalidate("org/kb");
    expect(await h.bg.tick(INTERVAL)).toEqual({ kind: "ran", synced: 1, failed: 0 });
    expect(h.registry.isInvalidated("org/kb")).toBe(false);
    // 次の周期までに TTL を過ぎる(15 秒以上経過した)minutes だけ同期する(kb は 5 秒前に同期済み)。
    h.clock.now += 5_000;
    expect(h.synced.at(-1)).toEqual(["org/kb"]);
    await h.bg.tick(INTERVAL);
    expect(h.synced.at(-1)).toEqual(["org/minutes"]);
  });

  it("失敗は recordError し、warn は失敗に転じたときだけ出す(周期ごとに繰り返さない)", async () => {
    const h = harness({ fail: ["org/minutes"] });
    await h.bg.tick(INTERVAL);
    await h.bg.tick(INTERVAL);
    expect(h.registry.lastError("org/minutes")).toContain("fetch failed");
    expect(h.registry.lastFetchedAt("org/minutes")).toBeUndefined();
    expect(h.warns).toHaveLength(1);
    h.fail.delete("org/minutes");
    await h.bg.tick(INTERVAL);
    expect(h.registry.lastError("org/minutes")).toBeUndefined();
    h.fail.add("org/minutes");
    h.clock.now += TTL;
    await h.bg.tick(INTERVAL);
    expect(h.warns).toHaveLength(2); // 回復後に再び失敗したら warn する
  });

  it("start は間隔ごとに tick し、stop でタイマを解除して以後は積まない(正常終了)", async () => {
    const h = harness();
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    h.bg.start(INTERVAL, {
      set: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clear: (t) => {
        (t as { cleared: boolean }).cleared = true;
      },
    });
    h.bg.start(INTERVAL); // 2 回目は無視
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(INTERVAL);
    h.bg.stop();
    expect(timers[0]?.cleared).toBe(true);
    expect(await h.bg.tick(INTERVAL)).toEqual({ kind: "stopped" });
    expect(h.synced).toEqual([]);
  });

  it("0 以下の間隔では start しない(ASK_BACKGROUND_SYNC_MS=0 で無効)", () => {
    const h = harness();
    const timers: unknown[] = [];
    h.bg.start(0, {
      set: (fn) => timers.push(fn),
      clear: () => {},
    });
    expect(timers).toEqual([]);
  });

  it("終了処理が始まったら(isStopped)積まれていた分も同期しない", async () => {
    const h = harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let stopped = false;
    // キューが空の判定を通した後、実行前に終了処理が始まるケースを再現する。
    const busy = h.queue.enqueue(() => gate, { priority: "low" });
    const bg = createAskBackgroundSync({
      registry: h.registry,
      syncer: {
        ...({} as RepoSyncer),
        syncEach: async () => {
          throw new Error("呼ばれない");
        },
      },
      isQueueIdle: () => true,
      enqueueLow: (task) => h.queue.enqueue(task, { priority: "low" }),
      ttlMs: TTL,
      isStopped: () => stopped,
      logger: { info: () => {}, warn: () => {} },
    });
    const tick = bg.tick(INTERVAL);
    stopped = true;
    release();
    await busy;
    expect(await tick).toEqual({ kind: "ran", synced: 0, failed: 0 });
  });
});
