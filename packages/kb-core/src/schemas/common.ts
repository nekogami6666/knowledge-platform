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

// --- ID 形式(design.md §4.2〜4.4。kind-<年4桁>-<連番4桁>) ---

export const KB_ID_RE = /^kb-\d{4}-\d{4}$/;
export const DR_ID_RE = /^dr-\d{4}-\d{4}$/;
export const Q_ID_RE = /^q-\d{4}-\d{4}$/;

export const kbIdSchema = z
  .string()
  .regex(KB_ID_RE, "id は kb-<年4桁>-<連番4桁> 形式である必要があります");
export const drIdSchema = z
  .string()
  .regex(DR_ID_RE, "id は dr-<年4桁>-<連番4桁> 形式である必要があります");
export const qIdSchema = z
  .string()
  .regex(Q_ID_RE, "id は q-<年4桁>-<連番4桁> 形式である必要があります");

export type KbId = z.infer<typeof kbIdSchema>;
export type DrId = z.infer<typeof drIdSchema>;
export type QId = z.infer<typeof qIdSchema>;

/** allocateId / validateRepo がパスから ID を取り出すための前方一致パターン。 */
export const ID_PREFIX_RE = /^(kb|dr|q)-(\d{4})-(\d{4})/;

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
