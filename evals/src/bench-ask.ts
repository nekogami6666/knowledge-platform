/**
 * /ask の速度ベンチ(/ask 高速化の計測)。golden 質問を本番と同じ QA パイプライン(createQaSearch +
 * qa/answer + 本番と同じ順序の system prompt)で synthetic コーパスに流し、1 問ごとの所要時間・ターン数・
 * ツール利用・費用を集計する。正答の採点(出典一致・judge)は run-qa.ts の役目で、ここは速度だけを見る。
 * 実 Claude を使うため CI のテストでは走らせない(CLI は認証 env が無ければ何もせず終わる)。
 * ADR-0002: コーパスは synthetic のみ。
 */
import type { QaSearch } from "@stratum/discord-bot/qa";
import type { GoldenQa } from "./golden.js";
import type { QaSystemPrompt } from "./run-qa.js";

/** 1 問の計測結果(質問本文・回答本文は持たない)。 */
export interface BenchRow {
  id: string;
  elapsedMs: number;
  /** 以下は検索が成功したときだけ(失敗時は error のみ)。 */
  numTurns?: number;
  durationApiMs?: number;
  startupMs?: number;
  toolCalls?: Record<string, number>;
  parallelTurns?: number;
  firstTurnCacheRead?: number;
  citations?: number;
  notFound?: boolean;
  /** 全試行(再試行を含む)の推定費用 USD の合計。どの試行にも無ければ undefined。 */
  costUsd?: number;
  /** 検索の試行回数(再試行を含む)。 */
  attempts: number;
  /** 失敗したときのエラー名・コード(本文は持たない)。 */
  error?: string;
}

/** 平均・中央値・最大(値が無ければ null)。 */
export interface Dist {
  mean: number;
  p50: number;
  max: number;
}

export interface BenchSummary {
  questions: number;
  errors: number;
  notFound: number;
  elapsedMs: Dist | null;
  numTurns: Dist | null;
  startupMs: Dist | null;
  /** 全問のツール呼び出し回数の合計(ツール名ごと)。 */
  toolCalls: Record<string, number>;
  /** 全問の並列ターン数の合計。 */
  parallelTurns: number;
  totalCostUsd: number | null;
}

/** 平均・中央値(偶数個は中央 2 つの平均)・最大。小数は 1 桁に丸める。 */
export function distOf(values: readonly number[]): Dist | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    mean: round1(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: round1(p50),
    max: sorted[sorted.length - 1] as number,
  };
}

/** 計測結果を集計する(純関数)。 */
export function summarizeBench(rows: readonly BenchRow[]): BenchSummary {
  const ok = rows.filter((r) => r.error === undefined);
  const nums = (pick: (r: BenchRow) => number | undefined): number[] =>
    ok.map(pick).filter((v): v is number => v !== undefined);
  const toolCalls: Record<string, number> = {};
  for (const r of ok) {
    for (const [name, n] of Object.entries(r.toolCalls ?? {})) {
      toolCalls[name] = (toolCalls[name] ?? 0) + n;
    }
  }
  const costs = rows.map((r) => r.costUsd).filter((v): v is number => v !== undefined);
  return {
    questions: rows.length,
    errors: rows.length - ok.length,
    notFound: ok.filter((r) => r.notFound === true).length,
    elapsedMs: distOf(rows.map((r) => r.elapsedMs)),
    numTurns: distOf(nums((r) => r.numTurns)),
    startupMs: distOf(nums((r) => r.startupMs)),
    toolCalls,
    parallelTurns: ok.reduce((a, r) => a + (r.parallelTurns ?? 0), 0),
    totalCostUsd:
      costs.length === 0 ? null : Math.round(costs.reduce((a, b) => a + b, 0) * 1e4) / 1e4,
  };
}

/** エラーの名前とコードだけを返す(message は社内パス等を含みうるため出さない)。 */
function errorLabel(err: unknown): string {
  if (typeof err !== "object" || err === null) return typeof err;
  const e = err as { name?: unknown; code?: unknown };
  const name = typeof e.name === "string" ? e.name : "Error";
  return typeof e.code === "string" ? `${name}:${e.code}` : name;
}

export interface BenchInput {
  golden: readonly GoldenQa[];
  /** 先頭から何問流すか。 */
  limit: number;
  systemPrompt: QaSystemPrompt;
  corpusDir: string;
}

export interface BenchDeps {
  search: QaSearch;
  /** 単調クロック ms(既定 performance.now)。 */
  monotonicMs?: () => number;
  /** 1 問終わるたびに呼ぶ(進捗表示用)。 */
  onRow?: (row: BenchRow) => void;
}

/** golden の先頭 limit 問を順に流して計測する(直列。並列にすると所要時間が比べられない)。 */
export async function runAskBench(input: BenchInput, deps: BenchDeps): Promise<BenchRow[]> {
  const clock = deps.monotonicMs ?? (() => performance.now());
  const rows: BenchRow[] = [];
  for (const g of input.golden.slice(0, Math.max(0, input.limit))) {
    let attempts = 0;
    let cost: number | undefined;
    const t0 = clock();
    let row: BenchRow;
    try {
      const r = await deps.search({
        ...input.systemPrompt,
        question: g.question,
        cwd: input.corpusDir,
        onAttempt: (u) => {
          attempts += 1;
          if (u?.totalCostUsd !== undefined) cost = (cost ?? 0) + u.totalCostUsd;
        },
      });
      row = {
        id: g.id,
        elapsedMs: Math.round(clock() - t0),
        attempts,
        citations: r.value.citations.length,
        notFound: r.value.notFound,
        ...(r.numTurns !== undefined ? { numTurns: r.numTurns } : {}),
        ...(r.durationApiMs !== undefined ? { durationApiMs: r.durationApiMs } : {}),
        ...(r.startupMs !== undefined ? { startupMs: r.startupMs } : {}),
        ...(r.toolCalls !== undefined ? { toolCalls: r.toolCalls } : {}),
        ...(r.parallelTurns !== undefined ? { parallelTurns: r.parallelTurns } : {}),
        ...(r.firstTurnCacheRead !== undefined ? { firstTurnCacheRead: r.firstTurnCacheRead } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    } catch (err) {
      row = {
        id: g.id,
        elapsedMs: Math.round(clock() - t0),
        attempts,
        error: errorLabel(err),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    }
    rows.push(row);
    deps.onRow?.(row);
  }
  return rows;
}
