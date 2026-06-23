/**
 * ベースライン比較(design.md §10.2:「スコア低下 10pt 以上で #stratum-ops にアラート」)。純関数。
 * 主指標は citationMatchRate(決定論的で安定)、副指標は validityRate(judge 由来でやや揺れる)。
 */

/** 週次 eval の比較対象スコア(0..1)。 */
export interface EvalScore {
  citationMatchRate: number;
  validityRate: number;
}

/** 10pt = 0.10 の低下でアラート。 */
export const DROP_THRESHOLD = 0.1;
// 浮動小数の誤差で「ちょうど 10pt」が閾値を僅かに下回るのを防ぐ許容差。
const EPSILON = 1e-9;

export interface MetricDrop {
  metric: keyof EvalScore;
  baseline: number;
  current: number;
  /** baseline - current(正なら低下)。 */
  delta: number;
}

export interface BaselineComparison {
  regressed: boolean;
  drops: MetricDrop[];
}

/** current が baseline から DROP_THRESHOLD 以上低下した指標を列挙する。 */
export function compareToBaseline(current: EvalScore, baseline: EvalScore): BaselineComparison {
  const metrics: (keyof EvalScore)[] = ["citationMatchRate", "validityRate"];
  const drops: MetricDrop[] = [];
  for (const metric of metrics) {
    const delta = baseline[metric] - current[metric];
    if (delta >= DROP_THRESHOLD - EPSILON) {
      drops.push({ metric, baseline: baseline[metric], current: current[metric], delta });
    }
  }
  return { regressed: drops.length > 0, drops };
}
