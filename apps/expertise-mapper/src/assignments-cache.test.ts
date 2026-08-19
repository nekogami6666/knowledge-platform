import { describe, expect, it } from "vitest";
import {
  mergeAssignments,
  partitionMaterials,
  readAssignmentsCache,
  serializeAssignments,
} from "./assignments-cache.js";
import type { TopicMaterial } from "./evidence.js";
import { createLogger } from "./logger.js";

const KB: TopicMaterial = {
  id: "kb:kb-2026-0142",
  kind: "kb-entry",
  title: "湿度対策",
  domain: "hardware",
  tags: [],
};
const REPO: TopicMaterial = { id: "repo:o/fw", kind: "repo", repo: "o/fw" };

function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger([], (l) => lines.push(l)), lines };
}

describe("readAssignmentsCache(ADR-0032 D3: 破損は自己修復)", () => {
  it("不在(null)は初回として空(warn なし)", () => {
    const { logger, lines } = captureLogger();
    expect(readAssignmentsCache(null, logger)).toEqual({});
    expect(lines).toHaveLength(0);
  });

  it("正常な JSON は assignments を返す", () => {
    const { logger } = captureLogger();
    const raw = JSON.stringify({ version: 1, assignments: { "kb:kb-2026-0142": "t1" } });
    expect(readAssignmentsCache(raw, logger)).toEqual({ "kb:kb-2026-0142": "t1" });
  });

  it("JSON でない・スキーマ不一致は warn + 空(全再クラスタで自己修復)", () => {
    const broken = captureLogger();
    expect(readAssignmentsCache("not json", broken.logger)).toEqual({});
    expect(broken.lines.some((l) => l.includes("全再クラスタ"))).toBe(true);

    const mismatch = captureLogger();
    expect(readAssignmentsCache(JSON.stringify({ version: 2 }), mismatch.logger)).toEqual({});
    expect(mismatch.lines.some((l) => l.includes("全再クラスタ"))).toBe(true);
  });
});

describe("serializeAssignments(決定的・キー昇順)", () => {
  it("キー順に依らず同じ出力になり、read と round-trip する", () => {
    const a = serializeAssignments(
      new Map([
        ["repo:o/fw", "t1"],
        ["kb:kb-2026-0142", "t1"],
      ]),
    );
    const b = serializeAssignments(
      new Map([
        ["kb:kb-2026-0142", "t1"],
        ["repo:o/fw", "t1"],
      ]),
    );
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    const { logger } = captureLogger();
    expect(readAssignmentsCache(a, logger)).toEqual({
      "kb:kb-2026-0142": "t1",
      "repo:o/fw": "t1",
    });
  });
});

describe("partitionMaterials(ADR-0032 D2)", () => {
  it("現行 topic への割当だけ命中し、未登載・消滅 topic は LLM 行き", () => {
    const cache = { "kb:kb-2026-0142": "alive", "repo:o/fw": "ghost" };
    const { cachedAssignments, uncached } = partitionMaterials(
      [KB, REPO],
      cache,
      new Set(["alive"]),
    );
    expect([...cachedAssignments]).toEqual([["kb:kb-2026-0142", "alive"]]);
    expect(uncached.map((m) => m.id)).toEqual(["repo:o/fw"]); // ghost topic は再クラスタへ
  });

  it("キャッシュ空なら全件 LLM 行き", () => {
    const { cachedAssignments, uncached } = partitionMaterials([KB, REPO], {}, new Set());
    expect(cachedAssignments.size).toBe(0);
    expect(uncached).toHaveLength(2);
  });
});

describe("mergeAssignments", () => {
  it("キャッシュ命中 ∪ LLM 結果(現存 material のみ = eviction は自然に起きる)", () => {
    const merged = mergeAssignments(
      new Map([["kb:kb-2026-0142", "t1"]]),
      new Map([["repo:o/fw", "t2"]]),
    );
    expect([...merged].sort()).toEqual([
      ["kb:kb-2026-0142", "t1"],
      ["repo:o/fw", "t2"],
    ]);
  });
});
