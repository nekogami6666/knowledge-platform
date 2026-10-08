import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  BotStore,
  InflightAskStore,
  ManagedCloneStore,
  QueryRecord,
  SharedAnswerStore,
} from "./db.js";

/**
 * better-sqlite3 の native バイナリが無い環境(= `pnpm approve-builds better-sqlite3` 未実施)では
 * このスイートを skip する。静的 import は collection 時に native ロードでクラッシュするため、
 * 判定は同期 require プローブで行い、`createSqliteStore` は describe 内で lazy import する。
 */
function sqliteAvailable(): boolean {
  try {
    // require だけでは native バインディングのロードを強制できない実装があるため、
    // 実際に :memory: DB を生成して native ロードまで確かめる。
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      path: string,
    ) => { close(): void };
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

function sampleQuery(over: Partial<QueryRecord> = {}): QueryRecord {
  return {
    id: "q1",
    correlationId: "c1",
    discordUserId: "u1",
    discordChannelId: "ch1",
    threadId: null,
    question: "?",
    answer: "A",
    sourcesJson: null,
    answerStatus: "answered",
    feedback: null,
    inputTokens: 1,
    outputTokens: 2,
    elapsedMs: 10,
    createdAt: "2026-06-17T10:00:00+09:00",
    ...over,
  };
}

describe.skipIf(!sqliteAvailable())("createSqliteStore(:memory:)", () => {
  let createStore: (path: string) => BotStore & InflightAskStore;
  beforeAll(async () => {
    ({ createSqliteStore: createStore } = await import("./sqlite-store.js"));
  });

  it("recordQuery → getQuery が camelCase で読める(B1 回帰: snake→camel マッピング)", () => {
    const s = createStore(":memory:");
    s.recordQuery(sampleQuery({ id: "q1", correlationId: "corr-1", discordUserId: "user-1" }));
    const got = s.getQuery("q1");
    expect(got?.correlationId).toBe("corr-1");
    expect(got?.discordUserId).toBe("user-1");
    expect(got?.answer).toBe("A");
    expect(got?.feedback).toBeNull();
    s.close();
  });

  it("listQueries は created_at 順で全件を camelCase で返す", () => {
    const s = createStore(":memory:");
    s.recordQuery(sampleQuery({ id: "a", createdAt: "2026-06-17T10:00:00+09:00" }));
    s.recordQuery(sampleQuery({ id: "b", createdAt: "2026-06-17T11:00:00+09:00" }));
    expect(s.listQueries().map((q) => q.id)).toEqual(["a", "b"]);
    s.close();
  });

  it("setFeedback で 👍👎 を更新できる(§4.6)", () => {
    const s = createStore(":memory:");
    s.recordQuery(sampleQuery({ id: "q1", feedback: null }));
    s.setFeedback("q1", "up");
    expect(s.getQuery("q1")?.feedback).toBe("up");
    s.close();
  });

  it("answered / unanswered / delivery_failed / timeout / timeout_skipped / interrupted が round-trip する", () => {
    const s = createStore(":memory:");
    for (const status of [
      "answered",
      "unanswered",
      "delivery_failed",
      "timeout",
      "timeout_skipped",
      "interrupted",
    ] as const) {
      s.recordQuery(sampleQuery({ id: status, answerStatus: status }));
      expect(s.getQuery(status)?.answerStatus).toBe(status);
    }
    s.close();
  });

  it("hitRateLimit が増分し、limit 超で allowed=false", () => {
    const s = createStore(":memory:");
    const w = "2026-06-17T10";
    expect(s.hitRateLimit("user:1", "ask", w, 1)).toEqual({ count: 1, allowed: true });
    expect(s.hitRateLimit("user:1", "ask", w, 1)).toEqual({ count: 2, allowed: false });
    s.close();
  });

  it("queueAction → listPendingActions(type フィルタ・camelCase マッピング)", () => {
    const s = createStore(":memory:");
    s.queueAction({
      id: "a1",
      type: "question_queue",
      queryId: "q1",
      payloadJson: null,
      state: "pending",
      createdAt: "t",
    });
    s.queueAction({
      id: "a2",
      type: "freshness",
      queryId: null,
      payloadJson: null,
      state: "pending",
      createdAt: "t",
    });
    expect(s.listPendingActions()).toHaveLength(2);
    const qq = s.listPendingActions("question_queue");
    expect(qq).toHaveLength(1);
    expect(qq[0]?.queryId).toBe("q1");
    s.close();
  });

  it("markActionDone で state=done(未知 id は no-op)", () => {
    const s = createStore(":memory:");
    s.queueAction({
      id: "a1",
      type: "question_queue",
      queryId: "q1",
      payloadJson: null,
      state: "pending",
      createdAt: "t",
    });
    s.markActionDone("a1");
    expect(s.listPendingActions("question_queue")[0]?.state).toBe("done");
    s.markActionDone("unknown");
    s.close();
  });

  it("setActionState で中間状態へ前進(freshness の pending→sent・ADR-0019 D2)", () => {
    const s = createStore(":memory:");
    s.queueAction({
      id: "a1",
      type: "freshness",
      queryId: null,
      payloadJson: null,
      state: "pending",
      createdAt: "t",
    });
    s.setActionState("a1", "sent");
    expect(s.listPendingActions("freshness")[0]?.state).toBe("sent");
    s.setActionState("unknown", "sent");
    s.close();
  });

  it("setActionPayload で payload_json を差し替え(未知 id は no-op・ADR-0028 D1)", () => {
    const s = createStore(":memory:");
    s.queueAction({
      id: "a1",
      type: "interview_session",
      queryId: null,
      payloadJson: '{"chunks":[]}',
      state: "armed",
      createdAt: "t",
    });
    s.setActionPayload("a1", '{"chunks":[{"seq":1}]}');
    expect(s.listPendingActions("interview_session")[0]?.payloadJson).toBe(
      '{"chunks":[{"seq":1}]}',
    );
    s.setActionPayload("unknown", "{}");
    expect(s.listPendingActions()).toHaveLength(1);
    s.close();
  });
});

describe.skipIf(!sqliteAvailable())("inflight_asks(ADR-0035 追記・強制終了からの後始末)", () => {
  let createStore: (path: string) => BotStore & InflightAskStore;
  type RawDb = {
    exec(sql: string): void;
    pragma(s: string, o?: { simple: boolean }): unknown;
    close(): void;
  };
  let openRaw: (path: string) => RawDb;
  let dir: string;
  beforeAll(async () => {
    ({ createSqliteStore: createStore } = await import("./sqlite-store.js"));
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      path: string,
    ) => RawDb;
    openRaw = (p) => new Database(p);
    dir = mkdtempSync(join(tmpdir(), "inflight-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const row = (id: string, acceptedAtMs = 1000) => ({
    id,
    applicationId: "app-1",
    token: `tok-${id}`,
    acceptedAtMs,
    correlationId: `corr-${id}`,
  });

  it("add → list(受付順)→ remove(未知 id は no-op)", () => {
    const s = createStore(":memory:");
    s.addInflightAsk(row("b", 2000));
    s.addInflightAsk(row("a", 1000));
    expect(s.listInflightAsks()).toEqual([row("a", 1000), row("b", 2000)]);
    s.removeInflightAsk("a");
    s.removeInflightAsk("unknown");
    expect(s.listInflightAsks().map((r) => r.id)).toEqual(["b"]);
    s.close();
  });

  it("既存の v1 DB(旧コードが作成・データあり)を開くと表が追加され、user_version とデータは変わらない", () => {
    const p = join(dir, "v1.db");
    // 旧コード相当: 版 1 のスキーマだけの DB(inflight_asks は無い)を作る。
    const old = createStore(p);
    old.recordQuery(sampleQuery({ id: "old-q" }));
    old.close();
    const raw = openRaw(p);
    raw.exec("DROP TABLE inflight_asks");
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
    raw.close();

    const s = createStore(p);
    s.addInflightAsk(row("x"));
    expect(s.listInflightAsks()).toHaveLength(1);
    expect(s.getQuery("old-q")?.question).toBe("?");
    s.close();
    const after = openRaw(p);
    // 版番号は消費しない(managed_clones・shared_answers も同じ流儀)。
    expect(after.pragma("user_version", { simple: true })).toBe(1);
    after.close();
  });

  it("同じファイルを何度開いても冪等(行も保持)・ホスト側バッチが同時に開いても壊れない", () => {
    const p = join(dir, "idem.db");
    const a = createStore(p);
    a.addInflightAsk(row("keep"));
    // bot が開いたまま、別プロセス相当(gap-tracker 等)がもう一度開く。
    const b = createStore(p);
    expect(b.listInflightAsks().map((r) => r.id)).toEqual(["keep"]);
    b.close();
    a.close();
    const c = createStore(p);
    expect(c.listInflightAsks().map((r) => r.id)).toEqual(["keep"]);
    c.close();
  });

  it("countRecentInflight(update.sh 用): 15 分以内の行だけ数え、表が無い DB は 0", async () => {
    const { countRecentInflight } = await import("./inflight-count.js");
    const now = 100 * 60_000;
    const p = join(dir, "count.db");
    const s = createStore(p);
    s.addInflightAsk(row("recent", now - 60_000));
    s.addInflightAsk(row("stale", now - 20 * 60_000));
    s.close();
    const raw = openRaw(p) as unknown as Parameters<typeof countRecentInflight>[0] & RawDb;
    expect(countRecentInflight(raw, now)).toBe(1);
    raw.exec("DROP TABLE inflight_asks");
    expect(countRecentInflight(raw, now)).toBe(0);
    raw.close();
  });
});

describe.skipIf(!sqliteAvailable())("shared_answers(ADR-0040・回答の公開共有の記録)", () => {
  let createStore: (path: string) => BotStore & SharedAnswerStore;
  type RawDb = {
    exec(sql: string): void;
    pragma(s: string, o?: { simple: boolean }): unknown;
    close(): void;
  };
  let openRaw: (path: string) => RawDb;
  let dir: string;
  beforeAll(async () => {
    ({ createSqliteStore: createStore } = await import("./sqlite-store.js"));
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      path: string,
    ) => RawDb;
    openRaw = (p) => new Database(p);
    dir = mkdtempSync(join(tmpdir(), "shared-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const claim = (queryId: string) => ({
    queryId,
    sharedAt: "2026-10-07T10:00:00+09:00",
    channelId: "SHARE",
    sharedBy: "u1",
  });

  it("予約 → 投稿 ID の記録 → 二重予約は false(1 回答 1 回)", () => {
    const s = createStore(":memory:");
    expect(s.getSharedAnswer("q1")).toBeUndefined();
    expect(s.claimSharedAnswer(claim("q1"))).toBe(true);
    expect(s.getSharedAnswer("q1")).toEqual({ ...claim("q1"), messageId: null });
    s.completeSharedAnswer("q1", "m1");
    expect(s.claimSharedAnswer(claim("q1"))).toBe(false);
    expect(s.getSharedAnswer("q1")?.messageId).toBe("m1");
    s.close();
  });

  it("release は投稿前の予約だけを消す(投稿済みの記録は消さない)", () => {
    const s = createStore(":memory:");
    s.claimSharedAnswer(claim("a"));
    s.releaseSharedAnswer("a");
    expect(s.getSharedAnswer("a")).toBeUndefined();
    s.claimSharedAnswer(claim("b"));
    s.completeSharedAnswer("b", "m-b");
    s.releaseSharedAnswer("b");
    expect(s.getSharedAnswer("b")?.messageId).toBe("m-b");
    s.close();
  });

  it("既存 DB を開くと表が追加され、user_version とデータは変わらない・何度開いても冪等", () => {
    const p = join(dir, "v1.db");
    const old = createStore(p);
    old.recordQuery(sampleQuery({ id: "old-q" }));
    old.close();
    const raw = openRaw(p);
    raw.exec("DROP TABLE shared_answers");
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
    raw.close();

    const s = createStore(p);
    expect(s.claimSharedAnswer(claim("old-q"))).toBe(true);
    s.completeSharedAnswer("old-q", "m1");
    // bot が開いたまま、別プロセス相当(ホスト側バッチ)がもう一度開く。
    const again = createStore(p);
    expect(again.getSharedAnswer("old-q")?.messageId).toBe("m1");
    expect(again.getQuery("old-q")?.question).toBe("?");
    again.close();
    s.close();
    const after = openRaw(p);
    expect(after.pragma("user_version", { simple: true })).toBe(1);
    after.close();
  });
});

describe.skipIf(!sqliteAvailable())(
  "managed_clones(ADR-0036 D4・bot が作った clone の記録)",
  () => {
    let createStore: (path: string) => BotStore & ManagedCloneStore;
    type RawDb = {
      exec(sql: string): void;
      pragma(s: string, o?: { simple: boolean }): unknown;
      close(): void;
    };
    let openRaw: (path: string) => RawDb;
    let dir: string;
    beforeAll(async () => {
      ({ createSqliteStore: createStore } = await import("./sqlite-store.js"));
      const Database = createRequire(import.meta.url)("better-sqlite3") as new (
        path: string,
      ) => RawDb;
      openRaw = (p) => new Database(p);
      dir = mkdtempSync(join(tmpdir(), "managed-"));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("追加(同じ dir は冪等・最初の created_at を保つ)→ dir 昇順の一覧 → 削除(未知 dir は no-op)", () => {
      const s = createStore(":memory:");
      s.addManagedClone({ dir: "biz-minutes", repo: "org/biz-minutes", createdAt: "t1" });
      s.addManagedClone({ dir: "app", repo: "org/app", createdAt: "t2" });
      s.addManagedClone({ dir: "app", repo: "org/app", createdAt: "t3" });
      expect(s.listManagedClones()).toEqual([
        { dir: "app", repo: "org/app", createdAt: "t2" },
        { dir: "biz-minutes", repo: "org/biz-minutes", createdAt: "t1" },
      ]);
      s.removeManagedClone("app");
      s.removeManagedClone("unknown");
      expect(s.listManagedClones().map((c) => c.dir)).toEqual(["biz-minutes"]);
      s.close();
    });

    it("既存 DB を開くと表が追加され、user_version とデータは変わらない・何度開いても冪等", () => {
      const p = join(dir, "v1.db");
      const old = createStore(p);
      old.recordQuery(sampleQuery({ id: "old-q" }));
      old.close();
      const raw = openRaw(p);
      raw.exec("DROP TABLE managed_clones");
      expect(raw.pragma("user_version", { simple: true })).toBe(1);
      raw.close();

      const s = createStore(p);
      s.addManagedClone({ dir: "app", repo: "org/app", createdAt: "t" });
      // bot が開いたまま、別プロセス相当(ホスト側バッチ)がもう一度開く。
      const again = createStore(p);
      expect(again.listManagedClones().map((c) => c.dir)).toEqual(["app"]);
      expect(again.getQuery("old-q")?.question).toBe("?");
      again.close();
      s.close();
      const after = openRaw(p);
      expect(after.pragma("user_version", { simple: true })).toBe(1);
      after.close();
    });
  },
);
