/**
 * モデルロール → モデル ID の一元管理(design.md §5.2 / ADR-0008)。
 * 全アプリはロール名(fast / standard / deep)で参照し、モデル ID を直接書かない(CLAUDE.md §12.2)。
 * モデルは更新されるため、四半期ごとに本ファイルを見直す(design.md §5.2)。
 */

export type ModelRole = "fast" | "standard" | "deep";

/** LLM プロバイダ(ADR-0008)。第一者 API か Claude Platform on AWS(Claude Code on AWS)か。 */
export type LlmProvider = "anthropic" | "anthropic-aws";

/**
 * ロール → モデル ID(2026-06 時点。design.md §5.2 の表に一致)。
 * 第一者 API でも Claude Platform on AWS でも**素のモデル ID**(本家パリティ)。
 * - fast: 分類・ルーティング・💡スレッドの一次要約・鮮度確認文面生成
 * - standard: Q&A 回答生成・ナレッジ抽出・PR マイニング・矛盾検出
 * - deep: 月次の横断分析・インタビュー質問生成・専門性マップのトピック統合
 */
export const MODELS: Readonly<Record<ModelRole, string>> = {
  fast: "claude-haiku-4-5-20251001",
  standard: "claude-sonnet-4-6",
  deep: "claude-opus-4-8",
};

/** env からプロバイダを判定する。`CLAUDE_CODE_USE_ANTHROPIC_AWS` が "1"/"true" なら Claude Platform on AWS。 */
export function resolveProvider(
  source: Record<string, string | undefined> = process.env,
): LlmProvider {
  const v = source.CLAUDE_CODE_USE_ANTHROPIC_AWS;
  return v === "1" || v === "true" ? "anthropic-aws" : "anthropic";
}

/** ロールに対応するモデル ID を返す。第一者 / Claude Platform on AWS とも素の ID。 */
export function modelIdFor(role: ModelRole): string {
  return MODELS[role];
}
