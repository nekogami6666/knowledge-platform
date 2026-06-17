/**
 * モデルロール → モデル ID の一元管理(design.md §5.2)。
 * 全アプリはロール名(fast / standard / deep)で参照し、モデル ID を直接書かない(CLAUDE.md §12.2)。
 * モデルは更新されるため、四半期ごとに本ファイルを見直す(ADR 起票。design.md §5.2)。
 */

export type ModelRole = "fast" | "standard" | "deep";

/**
 * ロール → モデル ID(2026-06 時点。design.md §5.2 の表に一致)。
 * - fast: 分類・ルーティング・💡スレッドの一次要約・鮮度確認文面生成
 * - standard: Q&A 回答生成・ナレッジ抽出・PR マイニング・矛盾検出
 * - deep: 月次の横断分析・インタビュー質問生成・専門性マップのトピック統合
 */
export const MODELS: Readonly<Record<ModelRole, string>> = {
  fast: "claude-haiku-4-5-20251001",
  standard: "claude-sonnet-4-6",
  deep: "claude-opus-4-8",
};

/** ロールに対応するモデル ID を返す。 */
export function modelIdFor(role: ModelRole): string {
  return MODELS[role];
}
