/**
 * 一時的(リトライ可能)な失敗の判定(ADR-0015 D5 / ADR-0030 D3)。
 * voice-pipeline / interview-pipeline は「pending を残すか」の判定に、capture は
 * 「ユーザーに返す文面(再試行を待つ / 自分で付け直す)」の判定に使う。
 * capture.ts ← voice-pipeline.ts の依存があるため、共有はこの葉モジュールに置く(循環回避)。
 */
import { LlmError, RETRYABLE_LLM_CODES } from "@stratum/llm";

/** 429 / 529 / timeout 等の一時的な LLM 失敗か。 */
export function isTransient(err: unknown): boolean {
  return err instanceof LlmError && RETRYABLE_LLM_CODES.includes(err.code);
}
