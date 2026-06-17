/**
 * LLM 層の統一エラー(design.md §7.1)。基底クラス + 型付き code + cause を持つ
 * (packages/kb-core/src/errors.ts と同じ流儀)。利用側は message ではなく code で分岐する。
 */

export type LlmErrorCode =
  | "RATE_LIMITED" // 429。リトライ対象(§7.1)
  | "OVERLOADED" // 529。リトライ対象(§7.1)
  | "TIMEOUT" // タイムアウト。リトライ対象(§7.1)
  | "API_ERROR" // その他の API / ネットワーク失敗(リトライ対象外)
  | "BUDGET_EXCEEDED" // アプリ別の日次トークン上限超過(§7.3)
  | "STRUCTURED_PARSE" // 構造化出力の zod 再 parse 失敗(§7.2。client/agent 実装で使用)
  | "PROMPT_NOT_FOUND" // プロンプトファイル欠落(§8.1。prompts ローダで使用)
  | "PROMPT_INVALID"; // プロンプト frontmatter が不正(role 欠落/不正など、§8.1)

/** packages/llm が投げる統一エラー。 */
export class LlmError extends Error {
  readonly name = "LlmError";
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

/** withRetry が既定でリトライ対象とみなす code(§7.1: 429 / 529 / timeout)。 */
export const RETRYABLE_LLM_CODES: readonly LlmErrorCode[] = [
  "RATE_LIMITED",
  "OVERLOADED",
  "TIMEOUT",
];
