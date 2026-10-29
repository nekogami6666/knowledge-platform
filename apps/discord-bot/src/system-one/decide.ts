/**
 * System One の判定(ADR-0041 D1)。Jev の 3 型(yes/no・Choice・Score)を、共有の状態(retrieve.ts)と
 * 重み(weights.json)から**決定論的に**計算する純関数。乱数・時計・I/O を持たない。
 *
 * - Score(relevance): 候補ごとに潜在スコア s = bias + Σ w·f を Platt(a·s + b)で較正し、
 *   累積ロジット P(Y ≥ k) = σ(s' − θ_k)(k = 1..4)から 5 段階(0 = 無関係 … 4 = 直接の答え)の分布と期待値を出す。
 * - yes/no: p = σ(a·(bias + Σ w·f) + b)。
 * - Choice(primarySource): softmax(z / T)。T は温度(較正で当てる)。
 *
 * 特徴量はすべて 0〜1 に揃える(期待値は ÷4)。重みの無い特徴量は 0 として扱う(重みファイルの差し替えに強い)。
 * 較正スクリプトが同じ特徴量を使えるよう、特徴量の組み立て(explain)と確率への写像(decide)を分けて公開する。
 */
import type { SystemOneState } from "./retrieve.js";
import { SOURCE_KINDS, type SourceKind, type SystemOneWeights } from "./weights.js";

/** yes/no 判定。 */
export interface YesNo {
  /** 較正済みの確率(0〜1)。 */
  p: number;
}

/** Choice 判定。 */
export interface Choice<K extends string> {
  option: K;
  distribution: Record<K, number>;
  /** 選んだ選択肢の確率。 */
  confidence: number;
}

/** Score 判定(5 段階)。 */
export interface Score {
  /** P(level = 0..4)。合計 1。 */
  levels: [number, number, number, number, number];
  /** 期待値(0〜4)。 */
  expected: number;
}

export interface Decisions {
  timeSensitive: YesNo;
  needsCode: YesNo;
  answerableFromCandidates: YesNo;
  primarySource: Choice<SourceKind>;
  /** state.candidates と同順。 */
  relevance: Score[];
  /** 期待値の降順に並べた候補の添字(同点は元の順)。 */
  ranking: number[];
}

/** 判定の差し替え口(ADR-0041 D9)。外部モデル・embedding を使う置き換えは別 ADR 必須。 */
export type SystemOneDecider = (state: SystemOneState, weights: SystemOneWeights) => Decisions;

export type FeatureMap = Record<string, number>;

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** bias + Σ w·f(重みの無い特徴量・特徴量の無い重みは 0 扱い)。 */
export function linear(bias: number, weights: Record<string, number>, f: FeatureMap): number {
  let z = bias;
  for (const [k, w] of Object.entries(weights)) z += w * (f[k] ?? 0);
  return z;
}

/** 累積ロジットの 5 段階分布。latent は較正済み。 */
export function ordinalLevels(
  latent: number,
  thresholds: readonly number[],
): [number, number, number, number, number] {
  const ge = thresholds.map((t) => sigmoid(latent - t)); // P(Y >= 1..4)、thresholds 昇順なので単調減少
  const g1 = ge[0] ?? 0;
  const g2 = Math.min(g1, ge[1] ?? 0);
  const g3 = Math.min(g2, ge[2] ?? 0);
  const g4 = Math.min(g3, ge[3] ?? 0);
  return [1 - g1, g1 - g2, g2 - g3, g3 - g4, g4];
}

export function expectedOf(levels: readonly number[]): number {
  return levels.reduce((s, p, k) => s + k * p, 0);
}

/** 候補の関連度(較正前の潜在スコア)。 */
export function relevanceLatent(f: FeatureMap, w: SystemOneWeights): number {
  return linear(w.relevance.bias, w.relevance.weights, f);
}

/** 判定ごとの特徴量(較正スクリプトと共有)。 */
export interface Explanation {
  /** 候補ごとの関連度の較正前の潜在スコア。 */
  relevanceRaw: number[];
  relevance: Score[];
  ranking: number[];
  timeSensitive: FeatureMap;
  needsCode: FeatureMap;
  /** answerable の特徴量(needsCode / timeSensitive の確率を含むため、それらの後に作る)。 */
  answerable: FeatureMap;
  primarySource: FeatureMap;
  /** yes/no の較正前のロジット。 */
  raw: { timeSensitive: number; needsCode: number; answerable: number };
  /** Choice の較正前(温度 1)のロジット。 */
  primaryLogits: Record<SourceKind, number>;
}

function platt(z: number, p: { a: number; b: number }): number {
  return sigmoid(p.a * z + p.b);
}

/** 特徴量の組み立てと各判定の計算(decide の本体)。 */
export function explain(state: SystemOneState, w: SystemOneWeights): Explanation {
  const relevanceRaw = state.candidates.map((c) => relevanceLatent(c.features, w));
  const relevance = relevanceRaw.map((s) => {
    const levels = ordinalLevels(
      w.relevance.platt.a * s + w.relevance.platt.b,
      w.relevance.thresholds,
    );
    return { levels, expected: expectedOf(levels) };
  });
  const ranking = relevance
    .map((r, i) => ({ i, e: r.expected }))
    .sort((a, b) => b.e - a.e || a.i - b.i)
    .map((x) => x.i);
  const at = (k: number): { e: number; cov: number; kind: string } | null => {
    const idx = ranking[k];
    if (idx === undefined) return null;
    const c = state.candidates[idx];
    const r = relevance[idx];
    if (c === undefined || r === undefined) return null;
    return { e: r.expected / 4, cov: c.features.coverage, kind: c.kind };
  };
  const top1 = at(0);
  const top2 = at(1);
  const topOf = (kind: string): number => {
    for (const idx of ranking) {
      const c = state.candidates[idx];
      if (c?.kind === kind) return (relevance[idx]?.expected ?? 0) / 4;
    }
    return 0;
  };
  const relevantCount = relevance.filter((r) => r.expected >= 2).length;
  const top1Expected = top1?.e ?? 0;

  const timeSensitive: FeatureMap = {
    hasWindow: state.question.hasWindow,
    timeWords: state.question.timeWords,
  };
  const tsRaw = linear(w.timeSensitive.bias, w.timeSensitive.weights, timeSensitive);
  const tsP = platt(tsRaw, w.timeSensitive.platt);

  const needsCode: FeatureMap = {
    codeWords: state.question.codeWords,
    identifierLike: state.question.identifierLike,
    top1Expected,
  };
  const ncRaw = linear(w.needsCode.bias, w.needsCode.weights, needsCode);
  const ncP = platt(ncRaw, w.needsCode.platt);

  const answerable: FeatureMap = {
    top1Expected,
    gap12: Math.max(0, top1Expected - (top2?.e ?? 0)),
    top1Coverage: top1?.cov ?? 0,
    relevantCount: Math.min(1, Math.log1p(relevantCount) / Math.log(10)),
    needsCode: ncP,
    timeSensitive: tsP,
    hasCandidates: state.candidates.length > 0 ? 1 : 0,
  };
  const ansRaw = linear(w.answerable.bias, w.answerable.weights, answerable);

  const primarySource: FeatureMap = {
    bias: 1,
    kbTop: topOf("kb"),
    minutesTop: topOf("minutes"),
    discordTop: state.discordAvailable ? topOf("discord") : 0,
    needsCode: ncP,
    timeSensitive: tsP,
    top1Expected,
  };
  const primaryLogits = Object.fromEntries(
    SOURCE_KINDS.map((k) => [k, linear(0, w.primarySource.weights[k], primarySource)]),
  ) as Record<SourceKind, number>;

  return {
    relevanceRaw,
    relevance,
    ranking,
    timeSensitive,
    needsCode,
    answerable,
    primarySource,
    raw: { timeSensitive: tsRaw, needsCode: ncRaw, answerable: ansRaw },
    primaryLogits,
  };
}

/** softmax(z / T)。 */
export function softmax(logits: readonly number[], temperature: number): number[] {
  const z = logits.map((v) => v / temperature);
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** 判定(Jev の 3 型)。純関数・決定論的。 */
export const decide: SystemOneDecider = (state, w) => {
  const x = explain(state, w);
  const probs = softmax(
    SOURCE_KINDS.map((k) => x.primaryLogits[k]),
    w.primarySource.temperature,
  );
  const distribution = Object.fromEntries(SOURCE_KINDS.map((k, i) => [k, probs[i] ?? 0])) as Record<
    SourceKind,
    number
  >;
  let option: SourceKind = "none";
  let confidence = -1;
  for (const k of SOURCE_KINDS) {
    if (distribution[k] > confidence) {
      option = k;
      confidence = distribution[k];
    }
  }
  return {
    timeSensitive: { p: platt(x.raw.timeSensitive, w.timeSensitive.platt) },
    needsCode: { p: platt(x.raw.needsCode, w.needsCode.platt) },
    answerableFromCandidates: {
      p: state.candidates.length === 0 ? 0 : platt(x.raw.answerable, w.answerable.platt),
    },
    primarySource: { option, distribution, confidence },
    relevance: x.relevance,
    ranking: x.ranking,
  };
};

/** ゲートの段階。budget = 時間予算超過、それ以外は p(answerable) と閾値で決まる。 */
export type GateLevel = "high" | "mid" | "low";

/** p(answerable) と閾値からゲートを決める(候補が無ければ low)。 */
export function gateOf(d: Decisions, w: SystemOneWeights, candidateCount: number): GateLevel {
  if (candidateCount === 0) return "low";
  const p = d.answerableFromCandidates.p;
  if (p >= w.gate.high) return "high";
  if (p >= w.gate.mid) return "mid";
  return "low";
}
