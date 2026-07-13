import { describe, expect, it } from "vitest";
import type { EvidencePool } from "./evidence.js";
import { busFactor, computeTopics, riskOf } from "./metrics.js";

describe("busFactor(累積 2/3 カバレッジの最小人数・整数演算)", () => {
  const p = (counts: number[]) => counts.map((c) => ({ evidence_count: c }));
  it("1 人が 2/3 以上を占める → 1(§4.5「上位者が 1 人」)", () => {
    expect(busFactor(p([20, 5, 5]))).toBe(1); // 20/30 = 2/3 ちょうど
    expect(busFactor(p([29, 1]))).toBe(1);
    expect(busFactor(p([7]))).toBe(1);
  });
  it("2 人で 2/3 → 2", () => {
    expect(busFactor(p([10, 10, 10]))).toBe(2); // 20/30
    expect(busFactor(p([12, 10, 8, 3]))).toBe(2); // 22/33 = 2/3
  });
  it("均等分布は人数に比例して増える", () => {
    expect(busFactor(p([5, 5, 5, 5, 5, 5]))).toBe(4); // 20/30
  });
});

describe("riskOf(D6: bf=1 かつ doc<5 → high の正典化)", () => {
  it("マトリクス", () => {
    expect(riskOf(1, 0)).toBe("high");
    expect(riskOf(1, 4)).toBe("high");
    expect(riskOf(1, 5)).toBe("medium"); // 文書化十分でも 1 人は medium
    expect(riskOf(2, 4)).toBe("medium");
    expect(riskOf(2, 5)).toBe("low");
    expect(riskOf(3, 0)).toBe("low");
  });
});

describe("computeTopics(決定的・material 横断の合算)", () => {
  const pool: EvidencePool = {
    materials: [
      {
        material: {
          id: "kb:kb-2026-0001",
          kind: "kb-entry",
          title: "A",
          domain: "hardware",
          tags: [],
        },
        people: [
          { person: "yamada", count: 1, lastActive: "2026-06-01" },
          { person: "suzuki", count: 1, lastActive: "2026-05-01" },
        ],
      },
      {
        material: { id: "repo:o/fw", kind: "repo", repo: "o/fw" },
        people: [{ person: "yamada", count: 22, lastActive: "2026-07-05" }],
      },
      {
        material: { id: "kb:kb-2026-0002", kind: "kb-entry", title: "B", domain: "ops", tags: [] },
        people: [{ person: "tanaka", count: 1, lastActive: "2026-07-01" }],
      },
    ],
    unattributedCommits: {},
  };
  const assignments = new Map([
    ["kb:kb-2026-0001", "dispenser-x-firmware"],
    ["repo:o/fw", "dispenser-x-firmware"],
    // kb:kb-2026-0002 は未割当(除外され、topic を作らない)
  ]);
  const labels = new Map([["dispenser-x-firmware", "分注ユニット X ファームウェア"]]);

  it("people を横断合算し、documented は kb-entry のみ数え、bus_factor/risk を算出する", () => {
    const topics = computeTopics(pool, assignments, labels);
    expect(topics).toHaveLength(1);
    const t = topics[0];
    expect(t?.topic).toBe("dispenser-x-firmware");
    expect(t?.documented_kb_count).toBe(1); // repo は数えない
    expect(t?.people[0]).toEqual({ name: "yamada", evidence_count: 23, last_active: "2026-07-05" });
    expect(t?.people[1]).toEqual({ name: "suzuki", evidence_count: 1, last_active: "2026-05-01" });
    expect(t?.bus_factor).toBe(1); // yamada 23/24 >= 2/3
    expect(t?.risk).toBe("high"); // bf=1 かつ doc=1 < 5
  });

  it("label 欠落は fail-loud(クラスタリング検証のバグ検知)", () => {
    const bad = new Map([["kb:kb-2026-0001", "unknown-topic"]]);
    expect(() => computeTopics(pool, bad, labels)).toThrow(/label/);
  });
});
