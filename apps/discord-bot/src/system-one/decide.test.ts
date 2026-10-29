import { describe, expect, it } from "vitest";
import { decide, expectedOf, gateOf, ordinalLevels, softmax } from "./decide.js";
import type { Candidate, CandidateFeatures, SystemOneState } from "./retrieve.js";
import { loadDefaultWeights, SOURCE_KINDS, type SystemOneWeights } from "./weights.js";

const W = loadDefaultWeights();

const ZERO: CandidateFeatures = {
  title: 0,
  meta: 0,
  summary: 0,
  body: 0,
  coverage: 0,
  longest: 0,
  inWindow: 0,
  outWindow: 0,
  recency: 0,
  stale: 0,
};

function cand(
  path: string,
  f: Partial<CandidateFeatures>,
  kind: Candidate["kind"] = "kb",
): Candidate {
  return {
    kind,
    repo: "org/kb",
    path,
    url: null,
    title: path,
    date: "2026-06-01",
    features: { ...ZERO, ...f },
    firstHit: 0,
    body: "",
    hitWeight: 1,
  };
}

function state(
  candidates: Candidate[],
  q: Partial<SystemOneState["question"]> = {},
): SystemOneState {
  return {
    terms: [{ text: "脱調", weight: 0.7, kind: "kanji" }],
    window: null,
    question: { timeWords: 0, codeWords: 0, identifierLike: 0, hasWindow: 0, termCount: 0.1, ...q },
    candidates,
    discordAvailable: false,
    budgetExceeded: false,
  };
}

const strong = cand("knowledge/a.md", { title: 1, body: 1, coverage: 1, longest: 1, recency: 0.5 });
const weak = cand("knowledge/b.md", { body: 0.2, coverage: 0.2, longest: 0.3 }, "minutes");

describe("ordinalLevels / softmax", () => {
  it("5 段階の分布は合計 1・潜在スコアが大きいほど期待値が上がる", () => {
    const lo = ordinalLevels(-2, W.relevance.thresholds);
    const hi = ordinalLevels(6, W.relevance.thresholds);
    expect(lo.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(hi.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(lo.every((p) => p >= 0)).toBe(true);
    expect(expectedOf(hi)).toBeGreaterThan(expectedOf(lo));
    expect(expectedOf(hi)).toBeLessThanOrEqual(4);
  });

  it("softmax は合計 1・温度が高いほど平らになる", () => {
    const a = softmax([2, 0, -1], 1);
    const b = softmax([2, 0, -1], 5);
    expect(a.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
    expect(Math.max(...b)).toBeLessThan(Math.max(...a));
  });
});

describe("decide(Jev の 3 型・純関数)", () => {
  it("決定論的: 同じ入力・同じ重みなら同じ出力", () => {
    const s = state([weak, strong]);
    expect(decide(s, W)).toEqual(decide(structuredClone(s), structuredClone(W)));
  });

  it("Score: 期待値で並べ替え、強い一致が上位", () => {
    const d = decide(state([weak, strong]), W);
    expect(d.ranking).toEqual([1, 0]);
    expect(d.relevance[1]?.expected).toBeGreaterThan(d.relevance[0]?.expected ?? 0);
    for (const r of d.relevance) expect(r.levels).toHaveLength(5);
  });

  it("yes/no: 強い候補があれば answerable が高く、候補が無ければ 0", () => {
    expect(decide(state([strong]), W).answerableFromCandidates.p).toBeGreaterThan(0.8);
    expect(decide(state([weak]), W).answerableFromCandidates.p).toBeLessThan(0.5);
    expect(decide(state([]), W).answerableFromCandidates.p).toBe(0);
  });

  it("yes/no: 時間・コードの手がかりで timeSensitive / needsCode が上がる", () => {
    const base = decide(state([]), W);
    const t = decide(state([], { hasWindow: 1, timeWords: 1 }), W);
    const c = decide(state([], { codeWords: 1, identifierLike: 1 }), W);
    expect(t.timeSensitive.p).toBeGreaterThan(0.9);
    expect(base.timeSensitive.p).toBeLessThan(0.2);
    expect(c.needsCode.p).toBeGreaterThan(0.9);
    expect(base.needsCode.p).toBeLessThan(0.2);
  });

  it("Choice: 分布は 5 択で合計 1、confidence は選んだ選択肢の確率", () => {
    const d = decide(state([strong]), W);
    expect(Object.keys(d.primarySource.distribution).sort()).toEqual([...SOURCE_KINDS].sort());
    const sum = Object.values(d.primarySource.distribution).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(d.primarySource.option).toBe("kb");
    expect(d.primarySource.confidence).toBe(d.primarySource.distribution.kb);
    expect(decide(state([]), W).primarySource.option).toBe("none");
    expect(decide(state([], { codeWords: 1, identifierLike: 1 }), W).primarySource.option).toBe(
      "code",
    );
  });

  it("Platt の a/b が確率を動かす(較正パラメータが効く)", () => {
    const shifted: SystemOneWeights = {
      ...W,
      answerable: { ...W.answerable, platt: { a: 1, b: -5 } },
    };
    expect(decide(state([strong]), shifted).answerableFromCandidates.p).toBeLessThan(
      decide(state([strong]), W).answerableFromCandidates.p,
    );
  });
});

describe("gateOf(閾値)", () => {
  const withP = (p: number) => ({
    ...decide(state([strong]), W),
    answerableFromCandidates: { p },
  });
  it("high >= 0.8 / mid >= 0.5 / それ未満 low・候補 0 件は low", () => {
    expect(gateOf(withP(0.8), W, 1)).toBe("high");
    expect(gateOf(withP(0.79), W, 1)).toBe("mid");
    expect(gateOf(withP(0.5), W, 1)).toBe("mid");
    expect(gateOf(withP(0.49), W, 1)).toBe("low");
    expect(gateOf(withP(0.99), W, 0)).toBe("low");
  });
});
