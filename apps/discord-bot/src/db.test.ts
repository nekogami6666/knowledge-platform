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
    feedback: null,
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

  it("markActionDone で state=done に前進(未知 id は no-op・§6.5 gap-tracker の消費)", () => {
    const s = createMemoryStore();
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
    s.markActionDone("unknown"); // no-op(throw しない)
  });

  it("setActionState で中間状態へ前進(freshness の pending→sent・ADR-0019 D2)", () => {
    const s = createMemoryStore();
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
    s.setActionState("unknown", "sent"); // no-op(throw しない)
  });

  it("setActionPayload で payload を差し替え(interview のチャンク追記・ADR-0028 D1)", () => {
    const s = createMemoryStore();
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
    s.setActionPayload("unknown", "{}"); // no-op(throw しない)
    expect(s.listPendingActions()).toHaveLength(1);
  });
});

describe("createMemoryStore: feedback / answerStatus", () => {
  it("setFeedback で 👍👎 を更新でき、未知 id は no-op(§4.6)", () => {
    const s = createMemoryStore();
    s.recordQuery(sampleQuery({ id: "q1", feedback: null }));
    expect(s.getQuery("q1")?.feedback).toBeNull();
    s.setFeedback("q1", "down");
    expect(s.getQuery("q1")?.feedback).toBe("down");
    s.setFeedback("nope", "up"); // throw しない
  });

  it("answered / unanswered / delivery_failed / timeout が round-trip する", () => {
    const s = createMemoryStore();
    for (const status of ["answered", "unanswered", "delivery_failed", "timeout"] as const) {
      s.recordQuery(sampleQuery({ id: status, answerStatus: status }));
      expect(s.getQuery(status)?.answerStatus).toBe(status);
    }
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

describe("createMemoryStore: shared_answers(ADR-0040)", () => {
  const claim = (queryId: string) => ({
    queryId,
    sharedAt: "2026-10-07T10:00:00+09:00",
    channelId: "SHARE",
    sharedBy: "u1",
  });

  it("予約 → 投稿 ID の記録 → 二重予約は false(1 回答 1 回)", () => {
    const s = createMemoryStore();
    expect(s.getSharedAnswer("q1")).toBeUndefined();
    expect(s.claimSharedAnswer(claim("q1"))).toBe(true);
    expect(s.getSharedAnswer("q1")).toEqual({ ...claim("q1"), messageId: null });
    s.completeSharedAnswer("q1", "m1");
    expect(s.claimSharedAnswer(claim("q1"))).toBe(false);
    expect(s.getSharedAnswer("q1")?.messageId).toBe("m1");
  });

  it("release は投稿前の予約だけを消す(投稿済みの記録・未知 id は no-op)", () => {
    const s = createMemoryStore();
    s.claimSharedAnswer(claim("a"));
    s.releaseSharedAnswer("a");
    expect(s.getSharedAnswer("a")).toBeUndefined();
    s.claimSharedAnswer(claim("b"));
    s.completeSharedAnswer("b", "m-b");
    s.releaseSharedAnswer("b");
    s.releaseSharedAnswer("unknown");
    s.completeSharedAnswer("unknown", "m");
    expect(s.getSharedAnswer("b")?.messageId).toBe("m-b");
    expect(s.getSharedAnswer("unknown")).toBeUndefined();
  });
});

describe("createMemoryStore: managed_clones(ADR-0036 D4)", () => {
  it("追加(同じ dir は冪等・最初の createdAt を保つ)→ dir 昇順の一覧 → 削除(未知 dir は no-op)", () => {
    const s = createMemoryStore();
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
  });
});
