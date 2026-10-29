import { loadDefaultWeights, sigmoid } from "@stratum/discord-bot/system-one";
import { describe, expect, it } from "vitest";
import {
  calibrateWeights,
  expectedCalibrationError,
  fitLogistic,
  fitPlatt,
  fitTemperature,
  formatReports,
  parseLabelsJsonl,
  reliabilityBins,
} from "./system-one-calibration.js";
import {
  catalogOf,
  GOLDEN_NOW_MS,
  goldenAsLabeled,
  loadGolden,
  QA_CORPUS_DIR,
  QA_CORPUS_REPOS,
} from "./system-one-golden.js";

/** 決定論的な擬似乱数(線形合同法)。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 真の確率は σ(2z + 1) だが、モデルは σ(z) と言う(過小確信 + 偏り)合成データ。 */
function synthetic(n: number): { z: number[]; y: number[] } {
  const r = lcg(42);
  const z: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const zi = r() * 8 - 4;
    z.push(zi);
    y.push(r() < sigmoid(2 * zi + 1) ? 1 : 0);
  }
  return { z, y };
}

describe("Platt scaling と ECE(合成データ・ADR-0041 D7)", () => {
  it("較正すると ECE が下がり、真のパラメータ(a≈2, b≈1)に近づく", () => {
    const { z, y } = synthetic(4000);
    const before = z.map((v) => sigmoid(v));
    const p = fitPlatt(z, y);
    const after = z.map((v) => sigmoid(p.a * v + p.b));
    const eceBefore = expectedCalibrationError(before, y);
    const eceAfter = expectedCalibrationError(after, y);
    expect(eceAfter).toBeLessThan(eceBefore);
    expect(eceAfter).toBeLessThan(0.03);
    expect(p.a).toBeGreaterThan(1.7);
    expect(p.a).toBeLessThan(2.3);
    expect(p.b).toBeGreaterThan(0.7);
    expect(p.b).toBeLessThan(1.3);
  });

  it("片方のクラスしか無い・空なら恒等", () => {
    expect(fitPlatt([], [])).toEqual({ a: 1, b: 0 });
    expect(fitPlatt([1, 2], [1, 1])).toEqual({ a: 1, b: 0 });
  });

  it("信頼度図: 件数・平均確率・正解率", () => {
    const bins = reliabilityBins([0.05, 0.15, 0.95, 0.99], [0, 0, 1, 0], 10);
    expect(bins[0]).toMatchObject({ count: 1, accuracy: 0 });
    expect(bins[9]?.count).toBe(2);
    expect(bins[9]?.accuracy).toBe(0.5);
    expect(expectedCalibrationError([], [])).toBe(0);
  });

  it("ロジスティック回帰は分離できる特徴量の重みを正にする", () => {
    const xs = Array.from({ length: 200 }, (_, i) => ({ f: i % 2 }));
    const y = xs.map((x) => x.f);
    const fit = fitLogistic(xs, y, { bias: 0, weights: { f: 0 } });
    expect(fit.weights.f).toBeGreaterThan(2);
    expect(fit.bias).toBeLessThan(0);
  });

  it("温度: 過信した logits は T > 1 で平らにする", () => {
    const r = lcg(7);
    const logits: number[][] = [];
    const labels: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const k = Math.floor(r() * 3);
      // 正解に +4 だが、40% は別のクラスが正解(過信)。
      const truth = r() < 0.6 ? k : (k + 1) % 3;
      logits.push([0, 1, 2].map((j) => (j === k ? 4 : 0)));
      labels.push(truth);
    }
    expect(fitTemperature(logits, labels)).toBeGreaterThan(1.5);
  });

  it("JSONL のラベルを読む(壊れた行は例外・必須欄の無い行は捨てる)", () => {
    const raw = [
      JSON.stringify({
        question: "Q",
        citedKinds: ["minutes"],
        citedPaths: [{ kind: "github_file", repo: "org/m", path: "a.md" }],
      }),
      JSON.stringify({ citedPaths: [] }),
      "",
    ].join("\n");
    expect(parseLabelsJsonl(raw)).toEqual([
      {
        question: "Q",
        cited: [{ kind: "github_file", repo: "org/m", path: "a.md" }],
        citedKinds: ["minutes"],
      },
    ]);
  });
});

describe("golden-qa での較正(パイプラインが通ること)", () => {
  it("calibrateWeights は検証を通る重みと各判定のレポートを返す", async () => {
    const catalog = await catalogOf(QA_CORPUS_DIR, QA_CORPUS_REPOS);
    const { weights, reports } = await calibrateWeights(
      [{ questions: goldenAsLabeled(loadGolden()), catalog }],
      loadDefaultWeights(),
      GOLDEN_NOW_MS,
    );
    expect(reports.map((r) => r.name)).toEqual([
      "relevance(引用 = 関連度 3 以上)",
      "needsCode",
      "answerable",
      "primarySource(確信度 vs 正解)",
    ]);
    expect(weights.relevance.platt.a).toBeGreaterThan(0);
    expect(weights.primarySource.temperature).toBeGreaterThan(0);
    expect(formatReports(reports)).toContain("ECE");
  });
});
