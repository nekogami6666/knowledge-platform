import { describe, expect, it } from "vitest";
import { createMemoryStore, type QueryRecord } from "./db.js";

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
    inputTokens: 1,
    outputTokens: 2,
    elapsedMs: 10,
    createdAt: "2026-06-17T10:00:00+09:00",
    ...over,
  };
}

describe("createMemoryStore: queries", () => {
  it("recordQuery → getQuery / listQueries", () => {
    const s = createMemoryStore();
    s.recordQuery(sampleQuery());
    expect(s.getQuery("q1")?.answer).toBe("A");
    expect(s.listQueries()).toHaveLength(1);
    expect(s.getQuery("nope")).toBeUndefined();
  });
});

describe("createMemoryStore: pending_actions", () => {
  it("queueAction → listPendingActions(type フィルタ)", () => {
    const s = createMemoryStore();
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
    expect(s.listPendingActions("question_queue")).toHaveLength(1);
    expect(s.listPendingActions("question_queue")[0]?.id).toBe("a1");
  });
});

describe("createMemoryStore: hitRateLimit", () => {
  it("count が増え、limit 超で allowed=false", () => {
    const s = createMemoryStore();
    const w = "2026-06-17T10";
    expect(s.hitRateLimit("user:1", "ask", w, 2)).toEqual({ count: 1, allowed: true });
    expect(s.hitRateLimit("user:1", "ask", w, 2)).toEqual({ count: 2, allowed: true });
    expect(s.hitRateLimit("user:1", "ask", w, 2)).toEqual({ count: 3, allowed: false });
  });

  it("subject / window が違えば別カウント", () => {
    const s = createMemoryStore();
    expect(s.hitRateLimit("user:1", "ask", "w1", 1).count).toBe(1);
    expect(s.hitRateLimit("user:2", "ask", "w1", 1).count).toBe(1);
    expect(s.hitRateLimit("user:1", "ask", "w2", 1).count).toBe(1);
  });
});
