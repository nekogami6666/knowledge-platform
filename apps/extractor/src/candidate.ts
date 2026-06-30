/**
 * 抽出候補の中間スキーマ(design.md §6.3)。これは LLM が議事録から出す**中間型**であり、
 * kb-core の確定エントリ(KnowledgeEntry / DecisionRecord)ではない(F1b で materialize する)。
 * よって kb-core 型の再定義には当たらない(CLAUDE.md §12.2)。enum 値域は kb-core と一致させ、
 * F1b の materialize マッピングが全域になるようにする。
 *
 * 重要(§9.5 / ask.ts と同思想): LLM には id / ref / commit SHA を出させない(信頼できない入力)。
 * 出典の確定(repo/path/ref=SHA)はコード側が後付けする。候補は本文・行範囲ヒント・自己申告のみ持つ。
 */
import { z } from "zod";

/** 議事録内の行範囲ヒント。kb-core source.ts の LINE_RANGE_RE と同形式(中間型のためローカル定義)。 */
const lineHintSchema = z.string().regex(/^L\d+(?:-L\d+)?$/);

/** 自己申告の確信度(kb-core Confidence と同値域)。 */
const confidenceSchema = z.enum(["high", "medium", "low"]);

/** ファイル名スラグ(ASCII kebab)。LLM が日本語タイトルから短い英語スラグを出す。任意。 */
const slugSchema = z.string().regex(/^[a-z0-9-]+$/);

/** 決定候補(→ F1b で DecisionRecord に materialize)。 */
export const decisionCandidateSchema = z
  .object({
    kind: z.literal("decision"),
    title: z.string().min(1),
    /** 決定内容。 */
    decision: z.string().min(1),
    /** なぜそう決めたか(あれば confidence を上げる根拠・§6.3)。 */
    rationale: z.string().optional(),
    /** 却下した代替案と理由(§6.3 で最重視)。 */
    rejectedAlternatives: z.string().optional(),
    /** 決定者(GitHub ユーザ名)。 */
    deciders: z.array(z.string().min(1)),
    lines: lineHintSchema.optional(),
    confidence: confidenceSchema,
    slug: slugSchema.optional(),
  })
  .strict();
export type DecisionCandidate = z.infer<typeof decisionCandidateSchema>;

/** 学び候補(→ F1b で KnowledgeEntry に materialize)。type は decision を除く kb-core EntryType。 */
export const learningCandidateSchema = z
  .object({
    kind: z.literal("learning"),
    title: z.string().min(1),
    body: z.string().min(1),
    entryType: z.enum(["learning", "procedure", "fact", "failure"]),
    domain: z.string().regex(/^[a-z0-9-]+$/),
    people: z.array(z.string().min(1)),
    tags: z.array(z.string().min(1)),
    lines: lineHintSchema.optional(),
    confidence: confidenceSchema,
    slug: slugSchema.optional(),
  })
  .strict();
export type LearningCandidate = z.infer<typeof learningCandidateSchema>;

/** 未解決の問い候補。F1 では materialize せず件数のみ計上(D7・gap-tracker の領域)。 */
export const openQuestionCandidateSchema = z
  .object({
    kind: z.literal("open_question"),
    title: z.string().min(1),
    body: z.string().min(1),
    lines: lineHintSchema.optional(),
  })
  .strict();
export type OpenQuestionCandidate = z.infer<typeof openQuestionCandidateSchema>;

/**
 * 1 議事録ファイルからの抽出結果。3 カテゴリは必須(LLM は常に出す。該当無しは空配列=雑談・連絡のみ・§6.3)。
 * 配列を `.default([])` にしないのは、zod default が input/output 型を分岐させ `z.ZodType<T>` と
 * 不整合になるため(qa/judge スキーマと同方針)。
 */
export const extractionResultSchema = z
  .object({
    decisions: z.array(decisionCandidateSchema),
    learnings: z.array(learningCandidateSchema),
    openQuestions: z.array(openQuestionCandidateSchema),
  })
  .strict();
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
