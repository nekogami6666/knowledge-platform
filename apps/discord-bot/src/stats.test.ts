import { describe, expect, it, vi } from "vitest";
import type { QueryRecord } from "./db.js";
import {
  aggregateStats,
  formatStatsMessage,
  runStatsReport,
  USEFUL_RATE_TARGET,
  WEEKLY_ASKS_TARGET,
} from "./stats.js";
import { isoJst } from "./time.js";

function q(over: Partial<QueryRecord>): QueryRecord {
  return {
    id: "id",
    correlationId: "c",
    discordUserId: "u",
    discordChannelId: "ch",
    threadId: null,
    question: "q?",
    answer: null,
    sourcesJson: null,
    answerStatus: "answered",
    feedback: null,
    inputTokens: null,
    outputTokens: null,
    elapsedMs: null,
    createdAt: isoJst(new Date("2026-07-20T00:00:00Z")),
    ...over,
  };
}

const NOW = new Date("2026-07-24T12:00:00Z");
const IN = isoJst(new Date("2026-07-20T00:00:00Z")); // 直近7日内
const OUT = isoJst(new Date("2026-07-10T00:00:00Z")); // 7日より前

describe("aggregateStats", () => {
  it("直近 windowDays の created_at だけをウィンドウ集計し、累計は全件", () => {
    const s = aggregateStats(
      [
        q({ id: "a", createdAt: IN, feedback: "up" }),
        q({ id: "b", createdAt: OUT, feedback: "up" }), // 窓外
      ],
      NOW,
    );
    expect(s.window.asks).toBe(1); // IN のみ
    expect(s.window.up).toBe(1);
    expect(s.total.asks).toBe(2); // 累計は両方
    expect(s.total.up).toBe(2);
  });

  it("評価が1件も無ければ usefulRate は null(0除算しない)", () => {
    const s = aggregateStats([q({ createdAt: IN }), q({ createdAt: IN })], NOW);
    expect(s.window.usefulRate).toBeNull();
    expect(s.window.unrated).toBe(2);
  });

  it("usefulRate = up/(up+down)、未評価は分母に入れない", () => {
    const s = aggregateStats(
      [
        q({ id: "1", createdAt: IN, feedback: "up" }),
        q({ id: "2", createdAt: IN, feedback: "up" }),
        q({ id: "3", createdAt: IN, feedback: "up" }),
        q({ id: "4", createdAt: IN, feedback: "down" }),
        q({ id: "5", createdAt: IN, feedback: null }),
      ],
      NOW,
    );
    expect(s.window.usefulRate).toBeCloseTo(0.75); // 3/(3+1)
    expect(s.window.unrated).toBe(1);
  });

  it("error / delivery_failed は answered / unanswered と分離して errors に数える", () => {
    const s = aggregateStats(
      [
        q({ id: "1", createdAt: IN, answerStatus: "answered" }),
        q({ id: "2", createdAt: IN, answerStatus: "unanswered" }),
        q({ id: "3", createdAt: IN, answerStatus: "error" }),
        q({ id: "4", createdAt: IN, answerStatus: "delivery_failed" }),
      ],
      NOW,
    );
    expect(s.window.answered).toBe(1);
    expect(s.window.unanswered).toBe(1);
    expect(s.window.errors).toBe(2);
    expect(s.window.answerRate).toBeCloseTo(0.25); // answered/asks = 1/4
  });

  it("avgElapsedMs は elapsedMs 非 null の平均(null は無視)", () => {
    const s = aggregateStats(
      [
        q({ id: "1", createdAt: IN, elapsedMs: 1000 }),
        q({ id: "2", createdAt: IN, elapsedMs: 3000 }),
        q({ id: "3", createdAt: IN, elapsedMs: null }),
      ],
      NOW,
    );
    expect(s.window.avgElapsedMs).toBe(2000);
  });

  it("空データはゼロ + null(クラッシュしない)", () => {
    const s = aggregateStats([], NOW);
    expect(s.window.asks).toBe(0);
    expect(s.window.usefulRate).toBeNull();
    expect(s.window.answerRate).toBeNull();
    expect(s.window.avgElapsedMs).toBeNull();
    expect(s.total.asks).toBe(0);
  });
});

describe("formatStatsMessage", () => {
  it("KPI 未達(件数 < 目標 / 有用率 < 目標)に ⚠️ を付ける", () => {
    const s = aggregateStats(
      [
        q({ id: "1", createdAt: IN, feedback: "up" }),
        q({ id: "2", createdAt: IN, feedback: "down" }),
        q({ id: "3", createdAt: IN, feedback: "down" }), // 有用率 1/3 < 0.7
      ],
      NOW,
    );
    const msg = formatStatsMessage(s);
    expect(s.window.asks).toBeLessThan(WEEKLY_ASKS_TARGET);
    expect(s.window.usefulRate).toBeLessThan(USEFUL_RATE_TARGET);
    // 件数行と有用率行の両方に ⚠️
    expect(msg).toMatch(/\/ask: 3 件 ⚠️/);
    expect(msg).toMatch(/有用率 33% ⚠️/);
    expect(msg).toContain("📊");
    expect(msg).toContain("累計");
  });

  it("KPI 達成(件数・有用率とも目標以上)なら ⚠️ を付けない", () => {
    const records = Array.from({ length: WEEKLY_ASKS_TARGET }, (_, i) =>
      q({ id: String(i), createdAt: IN, feedback: "up" }),
    );
    const msg = formatStatsMessage(aggregateStats(records, NOW));
    expect(msg).not.toContain("⚠️"); // 15件・有用率100% で全達成
  });

  it("評価ゼロなら有用率は「—」で ⚠️ を付けない(件数行の警告とは独立)", () => {
    const msg = formatStatsMessage(aggregateStats([q({ createdAt: IN })], NOW));
    expect(msg).toContain("有用率 —");
    expect(msg).not.toMatch(/有用率 — ⚠️/); // 有用率行には警告なし(null は未達扱いしない)
  });
});

describe("runStatsReport", () => {
  it("集計 → 本文を post し、サマリを返す", async () => {
    const records = [
      q({ id: "1", createdAt: IN, feedback: "up" }),
      q({ id: "2", createdAt: IN, feedback: "up" }),
    ];
    const posted: string[] = [];
    const summary = await runStatsReport({
      store: { listQueries: () => records },
      now: () => NOW,
      post: async (c) => {
        posted.push(c);
      },
      logger: { info: vi.fn() },
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("📊");
    expect(posted[0]).toContain("/ask: 2 件");
    expect(summary.window.up).toBe(2);
  });
});
