/**
 * LLM 呼び出しの共通リトライ(design.md §7.1)。
 * 指数バックオフ(既定 最大 3 回)、429 / 529 / timeout を対象、それ以外は即時 throw。
 * sleep を注入可能にしてテストを即時化する(kb-core の IO 注入パターンと同趣旨)。
 */
import { LlmError, RETRYABLE_LLM_CODES } from "./errors.js";

export interface RetryOptions {
  /** 最大リトライ回数(初回試行は含まない)。既定 3。 */
  maxRetries?: number;
  /** 初回バックオフ(ms)。既定 500。 */
  baseDelayMs?: number;
  /** バックオフ上限(ms)。既定 10000。 */
  maxDelayMs?: number;
  /** リトライ対象判定。既定は LlmError の RATE_LIMITED / OVERLOADED / TIMEOUT。 */
  shouldRetry?: (error: unknown) => boolean;
  /** スリープ実装(テストで差し替え)。既定は setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function defaultShouldRetry(error: unknown): boolean {
  return error instanceof LlmError && RETRYABLE_LLM_CODES.includes(error.code);
}

/**
 * fn を実行し、リトライ対象エラーなら指数バックオフで最大 maxRetries 回まで再試行する。
 * リトライ対象外、または上限到達時は最後のエラーを throw する。
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const maxDelayMs = options?.maxDelayMs ?? 10_000;
  const shouldRetry = options?.shouldRetry ?? defaultShouldRetry;
  const sleep = options?.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !shouldRetry(error)) throw error;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }
  // ループ内で必ず return か throw するため到達しないが、戻り値型の充足のため。
  throw lastError;
}
