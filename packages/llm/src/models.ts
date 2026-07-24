/**
 * モデルロール → モデル ID の一元管理(design.md §5.2 / ADR-0008 / ADR-0009)。
 * 全アプリはロール名(fast / standard / deep)で参照し、モデル ID を直接書かない(CLAUDE.md §12.2)。
 * モデルは更新されるため、四半期ごとに本ファイルを見直す(design.md §5.2)。
 */

export type ModelRole = "fast" | "standard" | "deep";

/**
 * ロール → モデル ID(2026-06 時点。design.md §5.2 の表に一致)。
 * 全 AI 操作は Claude on AWS(本家パリティ)経由に統一(ADR-0009)。モデル ID は**素のまま**使う。
 * - fast: 分類・ルーティング・💡スレッドの一次要約・鮮度確認文面生成
 * - standard: Q&A 回答生成・ナレッジ抽出・PR マイニング・矛盾検出
 * - deep: 月次の横断分析・インタビュー質問生成・専門性マップのトピック統合 + golden eval の judge
 */
export const MODELS: Readonly<Record<ModelRole, string>> = {
  fast: "claude-haiku-4-5-20251001",
  standard: "claude-sonnet-4-6",
  deep: "claude-opus-4-8",
};

/** ロールに対応するモデル ID を返す。Claude on AWS は本家パリティのため素の ID(ADR-0009)。 */
export function modelIdFor(role: ModelRole): string {
  return MODELS[role];
}

/**
 * 音声文字起こし(STT)のモデル ID(ADR-0015 D2)。ModelRole(Claude プロンプト用)とは別軸で、
 * プロンプト frontmatter の role には使えない。エンジンは既存議事録パイプライン(QB-Meeting-Ops)と
 * 同一の OpenAI transcription API。共用キーのプロジェクトが利用可能な STT はこの diarize 版のみのため
 * これを既定にする(2026-07-23 実測: gpt-4o-transcribe / whisper-1 はアクセス不可)。話者分離は使わず
 * response_format=json で平文 text だけ消費する(stt.ts)ため、一人語り既定の方針は維持される。
 * 四半期見直し(§5.2)の対象に含める。
 */
export const STT_MODEL = "gpt-4o-transcribe-diarize";
