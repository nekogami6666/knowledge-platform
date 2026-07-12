/**
 * @stratum/llm — LLM 呼び出しの唯一の入口(design.md §5 / §6 の L2)。
 * モデル設定・リトライ・usage 記録・(後続で)プロンプトローダ・Agent SDK ラッパを集約する。
 * `@anthropic-ai/*` の直接 import は本パッケージ内だけに閉じる(CLAUDE.md §12.2)。
 */

// --- Agent SDK ラッパ(agentic search) ---
export {
  type AgentQueryFn,
  type AgentSearchOptions,
  type AgentSearchResult,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  type LlmDeps,
  runAgentSearch,
} from "./agent.js";
// --- エラー ---
export { LlmError, type LlmErrorCode, RETRYABLE_LLM_CODES } from "./errors.js";
// --- モデル設定 ---
// 全 AI 操作は Claude on AWS(Agent SDK)経由に統一(ADR-0009)。第一者直叩き(@anthropic-ai/sdk・
// generateStructured)とプロバイダ抽象(resolveProvider/LlmProvider)は撤去済み。
export { MODELS, type ModelRole, modelIdFor, STT_MODEL } from "./models.js";
// --- プロンプトローダ ---
export {
  createFsPromptStore,
  type LoadedPrompt,
  loadPrompt,
  type PromptStore,
} from "./prompts.js";
// --- リトライ ---
export { type RetryOptions, withRetry } from "./retry.js";
// --- STT(音声文字起こし。ADR-0015。音声のみ OpenAI・言語処理は Claude のまま)---
export {
  createOpenAiTranscriber,
  type OpenAiTranscriberOptions,
  type TranscribeInput,
  type TranscribeResult,
  type Transcriber,
} from "./stt.js";
// --- usage 記録 ---
export { nullUsageRecorder, type Usage, type UsageRecorder } from "./usage.js";
