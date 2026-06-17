import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { BotStore, QueryRecord } from "./db.js";

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
  let createStore: (path: string) => BotStore;
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

  it("answered / unanswered / delivery_failed が round-trip する", () => {
    const s = createStore(":memory:");
    for (const status of ["answered", "unanswered", "delivery_failed"] as const) {
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
});
