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
  type AgentSearchOptions,
  type AgentSearchResult,
  type LlmDeps,
  nullUsageRecorder,
  runAgentSearch,
  type UsageRecorder,
  withRetry,
} from "@stratum/llm";
import { type QaAnswer, type QaSearch, qaAnswerSchema } from "./ask.js";

// QA 契約を再 export(評価ハーネス等の外部消費者向け。型は ask.ts が正)。
export {
  buildRepoManifest,
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
}

/**
 * 実 agentic search(runAgentSearch + §6.2 の 1 回リトライ)を {@link QaSearch} として組み立てる。
 * `app: "discord-bot"`・`role: "standard"`・`outputSchema: qaAnswerSchema` を固定する。
 * Claude on AWS の認証(CLAUDE_CODE_USE_ANTHROPIC_AWS / ANTHROPIC_AWS_* / AWS_REGION)は
 * Agent SDK が process.env から自動取得する(deps には渡さない・ADR-0009)。
 */
export function createQaSearch(deps: QaSearchFactoryDeps = {}): QaSearch {
  const runSearch = deps.runSearch ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const maxRetries = deps.maxRetries ?? 1;
  return (input) =>
    withRetry(
      () =>
        runSearch<QaAnswer>(
          {
            app: "discord-bot",
            role: "standard",
            systemPrompt: input.systemPrompt,
            prompt: input.question,
            cwd: input.cwd,
            outputSchema: qaAnswerSchema,
          },
          { usage },
        ),
      { maxRetries },
    );
}
