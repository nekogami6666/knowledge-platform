/**
 * System One の較正(ADR-0041 D7)。依存を増やさず、数値計算は自前で行う。
 *
 * - Platt scaling: 較正前のロジット z に対し p = σ(a·z + b) を Newton 法で当てる(Platt 1999 の
 *   目標値の平滑化つき。件数が少なくても 0/1 に張り付かない)。
 * - 温度(Choice): softmax(z / T) の負の対数尤度を最小にする T を黄金分割探索で当てる。
 * - ロジスティック回帰(任意の重みの当て直し): L2 つきの勾配降下。現在の重みから始める。
 * - 信頼度図(10 ビン)と ECE(期待較正誤差 = Σ (n_b / N)·|正解率_b − 平均確率_b|)。
 *
 * 正解ラベル(質問ごと):
 * - relevance: 候補が引用されたか(「引用された = 関連度 3 以上」とみなし、P(Y ≥ 3) を較正する)
 * - answerableFromCandidates: 候補のどれかが引用されたか
 * - needsCode: KB・議事録・Discord 以外(コードのリポ・PR・Issue)が引用されたか
 * - primarySource: 最初の引用の種別(引用が無い = none)
 * - timeSensitive: 正解ラベルが無いため較正しない(手の重みのまま)
 */
import {
  buildState,
  type Catalog,
  type Explanation,
  explain,
  type FeatureMap,
  SOURCE_KINDS,
  type SourceKind,
  type SystemOneWeights,
  sigmoid,
  softmax,
} from "@stratum/discord-bot/system-one";

// --- 数値計算 ---

/** Platt scaling の結果(p = σ(a·z + b))。 */
export interface PlattParams {
  a: number;
  b: number;
}

/** Platt の正則化の強さ(恒等 a=1, b=0 へ引き戻す。少数データで発散させない)。 */
const PLATT_L2 = 1e-2;

/**
 * Platt scaling を Newton 法(直線探索つき)で当てる。目標値は Platt の平滑化(正例 (N+ + 1)/(N+ + 2)・
 * 負例 1/(N− + 2))で、恒等(a=1, b=0)へ弱く引き戻す L2 を足す(件数が少なくても発散しない)。
 * 件数が 0 または片方のクラスしか無いとき・傾き a が正にならないとき(並び順を反転させる較正は採らない)は
 * 恒等(a=1, b=0)を返す。
 */
export function fitPlatt(z: readonly number[], y: readonly number[]): PlattParams {
  const n = z.length;
  const pos = y.filter((v) => v === 1).length;
  const neg = n - pos;
  if (n === 0 || pos === 0 || neg === 0) return { a: 1, b: 0 };
  const hi = (pos + 1) / (pos + 2);
  const lo = 1 / (neg + 2);
  const t = y.map((v) => (v === 1 ? hi : lo));
  const loss = (a: number, b: number): number => {
    let l = (PLATT_L2 / 2) * ((a - 1) ** 2 + b ** 2);
    for (let i = 0; i < n; i += 1) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(a * (z[i] ?? 0) + b)));
      const ti = t[i] ?? 0;
      l -= ti * Math.log(p) + (1 - ti) * Math.log(1 - p);
    }
    return l;
  };
  let a = 1;
  let b = 0;
  let cur = loss(a, b);
  for (let iter = 0; iter < 100; iter += 1) {
    let ga = PLATT_L2 * (a - 1);
    let gb = PLATT_L2 * b;
    let haa = PLATT_L2;
    let hab = 0;
    let hbb = PLATT_L2;
    for (let i = 0; i < n; i += 1) {
      const zi = z[i] ?? 0;
      const p = sigmoid(a * zi + b);
      const d = p - (t[i] ?? 0);
      const w = p * (1 - p);
      ga += d * zi;
      gb += d;
      haa += w * zi * zi;
      hab += w * zi;
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    // 直線探索: 損失が下がる歩幅まで半分にする。
    let step = 1;
    let next = loss(a - da, b - db);
    while (next > cur && step > 1e-6) {
      step /= 2;
      next = loss(a - step * da, b - step * db);
    }
    if (next > cur) break;
    a -= step * da;
    b -= step * db;
    const improved = cur - next;
    cur = next;
    if (improved < 1e-10) break;
  }
  return a > 0 && Number.isFinite(a) && Number.isFinite(b) ? { a, b } : { a: 1, b: 0 };
}

/** 2 値の信頼度図の 1 ビン。 */
export interface ReliabilityBin {
  lo: number;
  hi: number;
  count: number;
  /** 平均確率(確信度)。 */
  meanP: number;
  /** 正解率。 */
  accuracy: number;
}

/** 等幅ビンの信頼度図。 */
export function reliabilityBins(
  p: readonly number[],
  y: readonly number[],
  bins = 10,
): ReliabilityBin[] {
  const out: ReliabilityBin[] = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    count: 0,
    meanP: 0,
    accuracy: 0,
  }));
  p.forEach((pi, i) => {
    const k = Math.min(bins - 1, Math.max(0, Math.floor(pi * bins)));
    const bin = out[k] as ReliabilityBin;
    bin.count += 1;
    bin.meanP += pi;
    bin.accuracy += y[i] ?? 0;
  });
  for (const b of out) {
    if (b.count > 0) {
      b.meanP /= b.count;
      b.accuracy /= b.count;
    }
  }
  return out;
}

/** ECE(期待較正誤差)。件数 0 なら 0。 */
export function expectedCalibrationError(
  p: readonly number[],
  y: readonly number[],
  bins = 10,
): number {
  const n = p.length;
  if (n === 0) return 0;
  return reliabilityBins(p, y, bins).reduce(
    (s, b) => s + (b.count / n) * Math.abs(b.accuracy - b.meanP),
    0,
  );
}

/** softmax(z / T) の負の対数尤度を最小にする T(0.05〜20 の黄金分割探索)。件数 0 なら 1。 */
export function fitTemperature(logits: readonly number[][], labels: readonly number[]): number {
  if (logits.length === 0) return 1;
  const nll = (t: number): number =>
    logits.reduce((s, z, i) => {
      const p = softmax(z, t)[labels[i] ?? 0] ?? 0;
      return s - Math.log(Math.max(p, 1e-12));
    }, 0);
  // log T で探索する(T は桁で効く)。
  let lo = Math.log(0.05);
  let hi = Math.log(20);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = hi - g * (hi - lo);
  let d = lo + g * (hi - lo);
  for (let i = 0; i < 80; i += 1) {
    if (nll(Math.exp(c)) < nll(Math.exp(d))) hi = d;
    else lo = c;
    c = hi - g * (hi - lo);
    d = lo + g * (hi - lo);
  }
  return Math.exp((lo + hi) / 2);
}

/** L2 つきロジスティック回帰(勾配降下)。init から始め、キーは init の weights に揃える。 */
export function fitLogistic(
  xs: readonly FeatureMap[],
  y: readonly number[],
  init: { bias: number; weights: Record<string, number> },
  opts: { lr?: number; iters?: number; l2?: number } = {},
): { bias: number; weights: Record<string, number> } {
  const keys = Object.keys(init.weights);
  const lr = opts.lr ?? 0.5;
  const iters = opts.iters ?? 3000;
  const l2 = opts.l2 ?? 1e-3;
  const n = xs.length;
  if (n === 0) return { bias: init.bias, weights: { ...init.weights } };
  let bias = init.bias;
  const w = keys.map((k) => init.weights[k] ?? 0);
  for (let it = 0; it < iters; it += 1) {
    let gb = 0;
    const gw = new Array<number>(keys.length).fill(0);
    for (let i = 0; i < n; i += 1) {
      const x = xs[i] as FeatureMap;
      let z = bias;
      keys.forEach((k, j) => {
        z += (w[j] ?? 0) * (x[k] ?? 0);
      });
      const d = sigmoid(z) - (y[i] ?? 0);
      gb += d;
      keys.forEach((k, j) => {
        gw[j] = (gw[j] ?? 0) + d * (x[k] ?? 0);
      });
    }
    bias -= (lr * gb) / n;
    keys.forEach((_, j) => {
      w[j] = (w[j] ?? 0) - lr * ((gw[j] ?? 0) / n + l2 * (w[j] ?? 0));
    });
  }
  return { bias, weights: Object.fromEntries(keys.map((k, j) => [k, w[j] ?? 0])) };
}

// --- ラベルつきの質問から較正する ---

/** 正解つきの質問 1 件(bot.db の書き出し or golden-qa)。 */
export interface LabeledQuestion {
  question: string;
  /** 検証を通った引用(github_file は repo + path、discord は url)。空 = 答えが無い。 */
  cited: { kind: string; repo?: string; path?: string; url?: string }[];
  /** 引用の種別(kb / minutes / code / discord)。cited と同順。 */
  citedKinds: string[];
}

/** JSONL(export-labels-cli の出力)→ 正解つきの質問。 */
export function parseLabelsJsonl(raw: string): LabeledQuestion[] {
  const out: LabeledQuestion[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const r = JSON.parse(line) as {
      question?: unknown;
      citedPaths?: unknown;
      citedKinds?: unknown;
    };
    if (typeof r.question !== "string" || !Array.isArray(r.citedPaths)) continue;
    out.push({
      question: r.question,
      cited: r.citedPaths as LabeledQuestion["cited"],
      citedKinds: Array.isArray(r.citedKinds) ? r.citedKinds.map(String) : [],
    });
  }
  return out;
}

/** 判定ごとの例(較正前のロジットと正解)。 */
export interface CalibrationExamples {
  relevance: { z: number; y: number; f: FeatureMap }[];
  answerable: { z: number; y: number; f: FeatureMap }[];
  needsCode: { z: number; y: number; f: FeatureMap }[];
  primary: { logits: number[]; label: number }[];
}

/** 関連度の例に使う候補の数(上位から)。 */
const RELEVANCE_TOP_K = 20;

const keyOf = (repo: string | null | undefined, path: string | null | undefined): string =>
  `${repo ?? ""}\u0000${path ?? ""}`;

/** 同じカタログ(コーパス)に対する質問の組。golden(qa-corpus)と bot.db(VM の clone)は別の組にする。 */
export interface LabeledGroup {
  questions: readonly LabeledQuestion[];
  catalog: Catalog;
}

/** 質問ごとに状態と特徴量を作り、各判定の(較正前の)ロジットと正解を集める。 */
export async function collectExamples(
  groups: readonly LabeledGroup[],
  weights: SystemOneWeights,
  nowMs: number,
): Promise<CalibrationExamples> {
  const ex: CalibrationExamples = { relevance: [], answerable: [], needsCode: [], primary: [] };
  for (const { questions, catalog } of groups) {
    for (const q of questions) {
      await collectOne(ex, q, catalog, weights, nowMs);
    }
  }
  return ex;
}

async function collectOne(
  ex: CalibrationExamples,
  q: LabeledQuestion,
  catalog: Catalog,
  weights: SystemOneWeights,
  nowMs: number,
): Promise<void> {
  {
    const state = await buildState({
      question: q.question,
      catalog,
      nowMs,
      monotonicMs: () => 0, // 較正では時間予算で打ち切らない
      deadline: Number.POSITIVE_INFINITY,
      maxCandidates: weights.retrieval.maxCandidates,
      minHitWeight: weights.retrieval.minHitWeight,
    });
    const x: Explanation = explain(state, weights);
    const cited = new Set(
      q.cited.filter((c) => c.kind === "github_file").map((c) => keyOf(c.repo, c.path)),
    );
    let anyCited = 0;
    x.ranking.forEach((idx, rank) => {
      const c = state.candidates[idx];
      if (c === undefined) return;
      const hit = cited.has(keyOf(c.repo, c.path)) ? 1 : 0;
      if (hit === 1) anyCited = 1;
      if (rank < RELEVANCE_TOP_K) {
        ex.relevance.push({ z: x.relevanceRaw[idx] ?? 0, y: hit, f: { ...c.features } });
      }
    });
    if (state.candidates.length > 0) {
      ex.answerable.push({ z: x.raw.answerable, y: anyCited, f: x.answerable });
    }
    ex.needsCode.push({
      z: x.raw.needsCode,
      y: q.citedKinds.includes("code") ? 1 : 0,
      f: x.needsCode,
    });
    const first = (q.citedKinds[0] ?? "none") as SourceKind;
    const label = SOURCE_KINDS.indexOf(SOURCE_KINDS.includes(first) ? first : "none");
    ex.primary.push({ logits: SOURCE_KINDS.map((k) => x.primaryLogits[k]), label });
  }
}

/** 判定 1 つの較正前後(ECE と信頼度図)。 */
export interface CalibrationReport {
  name: string;
  n: number;
  positives: number;
  eceBefore: number;
  eceAfter: number;
  binsBefore: ReliabilityBin[];
  binsAfter: ReliabilityBin[];
}

export interface CalibrateOptions {
  /** 特徴量の重みもロジスティック回帰で当て直す(件数が minRefit 以上の判定だけ)。 */
  refit?: boolean;
  /** 重みを当て直す最小件数(ADR-0041 未決事項 4: 少数で過学習させない)。 */
  minRefit?: number;
}

/** 較正前後の ECE(当て直しで例の集合が変わりうるため、前後で正解の列を別に持つ)。 */
function report(
  name: string,
  before: { p: number[]; y: number[] },
  after: { p: number[]; y: number[] },
): CalibrationReport {
  return {
    name,
    n: before.y.length,
    positives: before.y.filter((v) => v === 1).length,
    eceBefore: expectedCalibrationError(before.p, before.y),
    eceAfter: expectedCalibrationError(after.p, after.y),
    binsBefore: reliabilityBins(before.p, before.y),
    binsAfter: reliabilityBins(after.p, after.y),
  };
}

/**
 * 例から weights を較正する。依存関係の順(relevance → needsCode → answerable → primarySource)に、
 * 前段を更新した重みで例を作り直しながら当てる。timeSensitive は変えない。
 */
export async function calibrateWeights(
  groups: readonly LabeledGroup[],
  base: SystemOneWeights,
  nowMs: number,
  opts: CalibrateOptions = {},
): Promise<{ weights: SystemOneWeights; reports: CalibrationReport[] }> {
  const minRefit = opts.minRefit ?? 200;
  const reports: CalibrationReport[] = [];
  let w: SystemOneWeights = structuredClone(base);
  const theta3 = w.relevance.thresholds[2] ?? 0;

  // 1) relevance: P(cited) = P(Y >= 3) = σ(a·s + b − θ3)。
  let ex = await collectExamples(groups, w, nowMs);
  {
    const y = ex.relevance.map((e) => e.y);
    const zs = ex.relevance.map((e) => e.z);
    const before = zs.map((z) => sigmoid(w.relevance.platt.a * z + w.relevance.platt.b - theta3));
    if (opts.refit === true && y.length >= minRefit) {
      const fit = fitLogistic(
        ex.relevance.map((e) => e.f),
        y,
        { bias: w.relevance.bias - theta3, weights: w.relevance.weights },
      );
      w.relevance = {
        ...w.relevance,
        bias: fit.bias + theta3,
        weights: fit.weights,
        platt: { a: 1, b: 0 },
      };
    } else {
      const p = fitPlatt(zs, y);
      w.relevance = { ...w.relevance, platt: { a: p.a, b: p.b + theta3 } };
    }
    ex = await collectExamples(groups, w, nowMs);
    const after = ex.relevance.map((e) =>
      sigmoid(w.relevance.platt.a * e.z + w.relevance.platt.b - theta3),
    );
    reports.push(
      report(
        "relevance(引用 = 関連度 3 以上)",
        { p: before, y },
        { p: after, y: ex.relevance.map((e) => e.y) },
      ),
    );
  }

  // 2) needsCode / 3) answerable(2 値・Platt または当て直し)。
  for (const name of ["needsCode", "answerable"] as const) {
    const list = ex[name];
    const y = list.map((e) => e.y);
    const cur = w[name];
    const before = list.map((e) => sigmoid(cur.platt.a * e.z + cur.platt.b));
    if (opts.refit === true && y.length >= minRefit) {
      const fit = fitLogistic(
        list.map((e) => e.f),
        y,
        cur,
      );
      w = { ...w, [name]: { ...cur, ...fit, platt: { a: 1, b: 0 } } };
    } else {
      w = {
        ...w,
        [name]: {
          ...cur,
          platt: fitPlatt(
            list.map((e) => e.z),
            y,
          ),
        },
      };
    }
    ex = await collectExamples(groups, w, nowMs);
    const nw = w[name];
    const after = ex[name].map((e) => sigmoid(nw.platt.a * e.z + nw.platt.b));
    reports.push(report(name, { p: before, y }, { p: after, y: ex[name].map((e) => e.y) }));
  }

  // 4) primarySource(温度)。ECE は「選んだ選択肢の確信度」と「当たったか」で測る。
  {
    const conf = (t: number) =>
      ex.primary.map((e) => {
        const p = softmax(e.logits, t);
        let k = 0;
        p.forEach((v, i) => {
          if (v > (p[k] ?? 0)) k = i;
        });
        return { p: p[k] ?? 0, ok: k === e.label ? 1 : 0 };
      });
    const before = conf(w.primarySource.temperature);
    const t = fitTemperature(
      ex.primary.map((e) => e.logits),
      ex.primary.map((e) => e.label),
    );
    w = { ...w, primarySource: { ...w.primarySource, temperature: t } };
    const after = conf(t);
    reports.push(
      report(
        "primarySource(確信度 vs 正解)",
        { p: before.map((x) => x.p), y: before.map((x) => x.ok) },
        { p: after.map((x) => x.p), y: after.map((x) => x.ok) },
      ),
    );
  }
  return { weights: w, reports };
}

/** 信頼度図と ECE を人が読める表にする。 */
export function formatReports(reports: readonly CalibrationReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(
      `## ${r.name}  n=${r.n} 正例=${r.positives}  ECE ${r.eceBefore.toFixed(4)} → ${r.eceAfter.toFixed(4)}`,
    );
    lines.push("bin        | 件数(前) 平均確率 正解率 | 件数(後) 平均確率 正解率");
    r.binsBefore.forEach((b, i) => {
      const a = r.binsAfter[i] as ReliabilityBin;
      if (b.count === 0 && a.count === 0) return;
      lines.push(
        `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}    | ${String(b.count).padStart(5)}  ${b.meanP.toFixed(3)}  ${b.accuracy.toFixed(3)} | ${String(a.count).padStart(5)}  ${a.meanP.toFixed(3)}  ${a.accuracy.toFixed(3)}`,
      );
    });
  }
  return lines.join("\n");
}
