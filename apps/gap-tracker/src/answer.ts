/**
 * gap 回答 → KnowledgeEntry(design.md §6.5 step4 / PR-D3a)。全部純関数(ユニットは fake 不要)。
 * - bot(PR-D2)が pending_actions(gap_answer)に積んだ回答を、kb-core の KnowledgeEntry へ写す。
 * - 型の唯一の正は kb-core(CLAUDE.md §12.2)。LLM 草案は中間型(id/sources/owner を持たない)。
 * - 出典は回答の Discord permalink(Source kind:"discord")。id・owner・日付はシステムが後付けする。
 */
import type { KnowledgeEntry } from "@stratum/kb-core";
import { z } from "zod";

/** bot(PR-D2 handleGapAnswer)が積む gap_answer の payload。 */
export const gapAnswerPayloadSchema = z.object({
  /** 依頼メッセージ本文の q-ID(questions/open/<id>.md を引くキー)。 */
  questionId: z.string().min(1),
  /** 回答者(担当者)の Discord ユーザ ID。owner の写像に使う。 */
  authorId: z.string().min(1),
  /** 回答本文(返信メッセージの content)。 */
  content: z.string().min(1),
  /** 回答メッセージの Discord permalink(出典)。 */
  messageUrl: z.string().min(1),
});
export type GapAnswerPayload = z.infer<typeof gapAnswerPayloadSchema>;

/**
 * LLM 草案(中間型・kb entry の再定義ではない)。回答はナレッジであって decision ではないため
 * entryType から decision を除く。id / sources / owner / 日付は出さない(システムが後付け)。
 */
// 配列を .default([]) にしないのは、zod default が input/output 型を分岐させ outputSchema:
// z.ZodType<T> に載らないため(extractor candidate.ts と同じ方針)。省略可は .optional() で表す。
export const answerEntryCandidateSchema = z.object({
  title: z.string().min(1),
  entryType: z.enum(["fact", "procedure", "learning", "failure"]),
  domain: z.string().regex(/^[a-z0-9-]+$/),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  confidence: z.enum(["high", "medium", "low"]),
  slug: z.string().optional(),
});
export type AnswerEntryCandidate = z.infer<typeof answerEntryCandidateSchema>;

export interface BuiltAnswerEntry {
  /** review_interval_days は type 別デフォルトを serializeEntry/parse が適用するため省略。 */
  frontmatter: Omit<KnowledgeEntry, "review_interval_days">;
  body: string;
  /** knowledge/<domain>/<id>-<slug>.md(repo 相対)。 */
  path: string;
}

/** JST(+09:00)の YYYY-MM-DD(kb-core の採番年基準に合わせる)。 */
function isoDateJst(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** ASCII kebab スラッグ(日本語 title は空になるため "entry" フォールバック)。 */
function slugOf(c: AnswerEntryCandidate): string {
  const s = (c.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "entry";
}

/**
 * gap 回答候補 → KnowledgeEntry(§4.2)。
 * 出典 = 回答の Discord permalink 1 件(P2: 出典のない知識は存在しない)。
 * owner = 回答者の GitHub 名(未マップは呼び出し側が既定を渡す)。people は owner のみ。
 */
export function buildAnswerEntry(
  id: string,
  candidate: AnswerEntryCandidate,
  sourceUrl: string,
  owner: string,
  now: Date,
): BuiltAnswerEntry {
  const today = isoDateJst(now);
  const frontmatter: Omit<KnowledgeEntry, "review_interval_days"> = {
    id: id as KnowledgeEntry["id"],
    title: candidate.title,
    type: candidate.entryType,
    domain: candidate.domain,
    tags: [...(candidate.tags ?? [])],
    sources: [{ kind: "discord", url: sourceUrl }],
    people: [owner],
    confidence: candidate.confidence,
    status: "active",
    created: today,
    last_verified: today,
    owner,
  };
  const body = `\n## 概要\n${candidate.body}\n`;
  const path = `knowledge/${candidate.domain}/${id}-${slugOf(candidate)}.md`;
  return { frontmatter, body, path };
}
