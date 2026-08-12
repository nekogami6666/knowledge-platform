import { z } from "zod";

/**
 * 共有の列挙・ID 形式・日付スキーマ。design.md §4.2〜4.5 を唯一の正として転記する。
 * 利用側はここで定義した enum / 型を再定義してはならない(CLAUDE.md §12.2)。
 */

// --- 列挙(design.md §4.2〜4.5) ---

export const ENTRY_TYPES = ["decision", "learning", "procedure", "fact", "failure"] as const;
export const entryTypeSchema = z.enum(ENTRY_TYPES);
export type EntryType = z.infer<typeof entryTypeSchema>;

export const ENTRY_STATUSES = ["active", "stale", "superseded"] as const;
export const entryStatusSchema = z.enum(ENTRY_STATUSES);
export type EntryStatus = z.infer<typeof entryStatusSchema>;

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof confidenceSchema>;

export const SOURCE_KINDS = [
  "meeting",
  "discord",
  "pr",
  "issue",
  "voice-memo",
  "interview",
] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

/**
 * 検証状態(ADR-0027 D4・kb-core v5)。機械生成エントリは常に unverified で作られ、人間の
 * 確認をもって verified に更新される。省略(既存エントリ)は legacy = 未分類。
 * last_verified は「内容の as-of 日(源泉日)」であり人間検証日ではない(ADR-0026 D3 の明確化)。
 */
export const VERIFICATION_STATUSES = ["unverified", "verified"] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const DR_STATUSES = ["proposed", "accepted", "superseded"] as const;
export const drStatusSchema = z.enum(DR_STATUSES);
export type DrStatus = z.infer<typeof drStatusSchema>;

export const QUESTION_STATUSES = ["open", "asked", "answered", "wontfix"] as const;
export const questionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

export const BOT_ANSWER_QUALITIES = ["unanswered", "downvoted"] as const;
export const botAnswerQualitySchema = z.enum(BOT_ANSWER_QUALITIES);
export type BotAnswerQuality = z.infer<typeof botAnswerQualitySchema>;

export const RISK_LEVELS = ["high", "medium", "low"] as const;
export const riskSchema = z.enum(RISK_LEVELS);
export type Risk = z.infer<typeof riskSchema>;

// --- ID 形式(design.md §4.2〜4.4 / ADR-0026) ---
// 新形式 = kind-<年4桁>-<base36 6文字>(乱数採番・counter 不要)。旧形式 = kind-<年4桁>-<連番4桁>。
// 既存エントリの旧 ID はリネームせず恒久共存するため、スキーマは両形式の和で受ける。
// suffix はちょうど4桁数字(旧)/ちょうど6文字(新)なので長さだけで新旧を機械判別できる。
// 新 suffix に `-` を含めないこと(ID_PREFIX_RE の前方一致がファイル名 slug に食い込まないための制約)。

// 6文字を先に試す(正規表現の選択は順序評価)。全数字6文字の新 ID をファイル名から前方一致で
// 切り出すとき、\d{4} が先だと先頭4桁で途中切りされるため、長い方を優先する。
const ID_SUFFIX = String.raw`(?:[0-9a-z]{6}|\d{4})`;

export const KB_ID_RE = new RegExp(`^kb-\\d{4}-${ID_SUFFIX}$`);
export const DR_ID_RE = new RegExp(`^dr-\\d{4}-${ID_SUFFIX}$`);
export const Q_ID_RE = new RegExp(`^q-\\d{4}-${ID_SUFFIX}$`);

export const kbIdSchema = z
  .string()
  .regex(KB_ID_RE, "id は kb-<年4桁>-<連番4桁|ランダム6文字> 形式である必要があります");
export const drIdSchema = z
  .string()
  .regex(DR_ID_RE, "id は dr-<年4桁>-<連番4桁|ランダム6文字> 形式である必要があります");
export const qIdSchema = z
  .string()
  .regex(Q_ID_RE, "id は q-<年4桁>-<連番4桁|ランダム6文字> 形式である必要があります");

export type KbId = z.infer<typeof kbIdSchema>;
export type DrId = z.infer<typeof drIdSchema>;
export type QId = z.infer<typeof qIdSchema>;

/** 採番/validateRepo がパスから ID を取り出すための前方一致パターン(新旧両対応)。 */
export const ID_PREFIX_RE = new RegExp(`^(kb|dr|q)-(\\d{4})-${ID_SUFFIX}`);

// --- 日付 / 日時 ---

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-06-10" 形式。暦として妥当であることも検証する。 */
export const dateOnlySchema = z
  .string()
  .regex(DATE_ONLY_RE, "日付は YYYY-MM-DD 形式である必要があります")
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "実在しない日付です");

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** "2026-06-09T14:22:00+09:00" 形式。タイムゾーンオフセット必須(design.md §7.5)。 */
export const isoDateTimeSchema = z
  .string()
  .regex(
    ISO_DATETIME_RE,
    "日時は ISO 8601・タイムゾーンオフセット付き(例 2026-06-09T14:22:00+09:00)である必要があります",
  );

// --- review_interval_days の type 別デフォルト(design.md §4.2) ---

/**
 * type 別のレビュー間隔(日)。`null` は鮮度確認の対象外(design.md の "∞")を意味する。
 * design.md §4.2 のコメントに `learning` の記載が欠落しているため、fact と同じ 180 を採用した
 * (本 PR での設計上の決定。詳細は PR 本文「レビュー済み所見」参照)。
 */
export const DEFAULT_REVIEW_INTERVAL_DAYS: Record<EntryType, number | null> = {
  procedure: 90,
  fact: 180,
  learning: 180,
  failure: 365,
  decision: null,
};
