/**
 * QA 検索の共有ファクトリ + 契約の公開バレル(`@stratum/discord-bot/qa` サブパス、PR-5)。
 *
 * bot 本体(index.ts)と golden eval(`@stratum/evals`)が**同一の Q&A パイプライン**
 * (runAgentSearch + qa/answer プロンプト + qaAnswerSchema + §6.2 リトライ)を駆動するために、
 * index.ts にインラインだった検索構築をここへ抽出する。
 *
 * 契約(qaAnswerSchema 等)は ask.ts が単一の正。ここはそれを再 export するだけで再定義しない
 * (CLAUDE.md §12.2)。import 方向は qa-search → ask の一方向(循環を作らない)。
 */
import {
  type AgentEffort,
  type AgentPrewarmPool,
  type AgentRunUsage,
  type AgentSearchOptions,
  type AgentSearchResult,
  type AgentThinking,
  type LlmDeps,
  LlmError,
  nullUsageRecorder,
  retryableExceptTimeout,
  runAgentSearch,
  type UsageRecorder,
  withRetry,
} from "@stratum/llm";
import { DEFAULT_ASK_TIMEOUT_MS, type QaAnswer, type QaSearch, qaAnswerSchema } from "./ask.js";
import { withPromptPrefix } from "./system-one/block.js";

// QA 契約を再 export(評価ハーネス等の外部消費者向け。型は ask.ts が正)。
export {
  type AskProgressEvent,
  buildRepoManifest,
  DEFAULT_ASK_TIMEOUT_MS,
  type QaAnswer,
  type QaCitation,
  type QaSearch,
  type QaSearchInput,
  qaAnswerSchema,
  qaCitationSchema,
  type ResolvedCitation,
  validateCitations,
} from "./ask.js";

/** runAgentSearch と同じ呼び出し形(テストで差し替え可能な seam)。 */
export type AgentSearchFn = <T>(
  opts: AgentSearchOptions<T>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<T>>;

export interface QaSearchFactoryDeps {
  /** Agent SDK 検索の実体(既定 runAgentSearch。ユニットテストでモック)。 */
  runSearch?: AgentSearchFn;
  /** usage 記録先(既定 no-op)。 */
  usage?: UsageRecorder;
  /** §6.2: 失敗時のリトライ回数(既定 1)。 */
  maxRetries?: number;
  /**
   * agentic search の上限 ms(既定 DEFAULT_ASK_TIMEOUT_MS)。検索対象(実 KB + minutes clone)の
   * 成長とともに所要時間が伸びるため、env(ASK_TIMEOUT_MS)からコード変更なしに調整できるようにする。
   */
  timeoutMs?: number;
  /** 最大ターン数(既定は runAgentSearch の 30。env ASK_MAX_TURNS・ADR-0035 D6)。 */
  maxTurns?: number;
  /** 努力度(既定 SDK 任せ。env ASK_EFFORT・ADR-0035 D6)。 */
  effort?: AgentEffort;
  /** 拡張思考(既定 SDK 任せ。env ASK_THINKING・ADR-0035 D6)。 */
  thinking?: AgentThinking;
  /**
   * subprocess の事前起動(ADR-0042。env ASK_PREWARM=on のときだけ index.ts が渡す)。未指定 = 従来どおり
   * 毎回 query() で起動する。
   */
  prewarm?: AgentPrewarmPool;
}

/**
 * /ask の再試行判定。TIMEOUT 以外の再試行対象に加え、STRUCTURED_PARSE(退化回答・形式崩れ)も
 * 1 回だけ検索し直す(2026-10-01「test」回答の不具合対策。回数は maxRetries で抑える)。
 */
export function shouldRetryAsk(error: unknown): boolean {
  return (
    retryableExceptTimeout(error) ||
    (error instanceof LlmError && error.code === "STRUCTURED_PARSE")
  );
}

/**
 * 実 agentic search(runAgentSearch + §6.2 の 1 回リトライ)を {@link QaSearch} として組み立てる。
 * `app: "discord-bot"`・`role: "qa"`(/ask 専用のモデル・ADR-0039)・`outputSchema: qaAnswerSchema` を固定する。
 * Claude on AWS の認証(CLAUDE_CODE_USE_ANTHROPIC_AWS / ANTHROPIC_AWS_* / AWS_REGION)は
 * Agent SDK が process.env から自動取得する(deps には渡さない・ADR-0009)。
 */
export function createQaSearch(deps: QaSearchFactoryDeps = {}): QaSearch {
  const runSearch = deps.runSearch ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const maxRetries = deps.maxRetries ?? 1;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  return (input) =>
    withRetry(
      async () => {
        // 段階 1-1: 試行ごとの使用量を input.onAttempt へ通知する(再試行された失敗回の費用も合算する
        // ため)。result の無い失敗(タイムアウト等)は null。
        let attemptUsage: AgentRunUsage | null = null;
        try {
          return await runSearch<QaAnswer>(
            {
              app: "discord-bot",
              role: "qa",
              systemPrompt: input.systemPrompt,
              ...(input.systemPromptDynamic !== undefined
                ? { systemPromptDynamic: input.systemPromptDynamic }
                : {}),
              // ADR-0041 D5: System One の候補ブロックがあれば質問の前に置く(system prompt は変えない)。
              prompt:
                input.promptPrefix === undefined
                  ? input.question
                  : withPromptPrefix(input.promptPrefix, input.question),
              cwd: input.cwd,
              outputSchema: qaAnswerSchema,
              timeoutMs,
              ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
              // 正常終了時の中断(ADR-0035 追記)。ABORTED は shouldRetryAsk の対象外なので再試行しない。
              ...(input.signal !== undefined ? { signal: input.signal } : {}),
              // ADR-0038 D6: /ask の discord_search(渡されたときだけ)。
              ...(input.inProcessTools !== undefined
                ? { inProcessTools: input.inProcessTools }
                : {}),
              ...(input.onAttempt !== undefined
                ? {
                    onUsage: (u: AgentRunUsage) => {
                      attemptUsage = u;
                    },
                  }
                : {}),
              ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
              ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
              ...(deps.thinking !== undefined ? { thinking: deps.thinking } : {}),
            },
            { usage, ...(deps.prewarm !== undefined ? { prewarm: deps.prewarm } : {}) },
          );
        } finally {
          input.onAttempt?.(attemptUsage);
        }
      },
      // TIMEOUT は再送しない(所要時間は検索対象サイズ比例 — 再送は待ち時間を倍にするだけで、
      // ユーザーは interaction の 15 分期限内で待っている・2026-08-16 の教訓)。
      { maxRetries, shouldRetry: shouldRetryAsk },
    );
}
