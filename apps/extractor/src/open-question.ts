/**
 * open question の materialize(ADR-0027 D3・旧⑰D7 の反転)。
 * 抽出された「未解決の問い」を kb-core QuestionLog として questions/open/ へ起票し、
 * 抽出 PR に同梱する(件数カウントだけで捨てない)。純関数(id/askedAt は呼び出し側が注入)。
 *
 * QuestionLog(§4.4)に sources フィールドは無い(出典は本文の記録)ため、元議事録の
 * repo/path/ref/lines は本文へ書く。frontmatter は questionLogSchema に完全準拠し、
 * serializeEntry が整形前に再検証する(parse/serialize round-trip はテストで固定)。
 */
import type { FileChange } from "@stratum/gh-client";
import { type QuestionLog, type Source, serializeEntry } from "@stratum/kb-core";
import type { OpenQuestionCandidate } from "./candidate.js";
import { slugify } from "./slug.js";

/**
 * 機械起票を示す asked_by の規約値(ADR-0027 D3)。人名・ID ではなくコンポーネント名。
 * gap-tracker の open スイープが依頼文の言い回しをこの値で分岐する(sweep.ts 側にも同じ規約値)。
 */
export const EXTRACTOR_ASKED_BY = "extractor";

/** ファイル参照型の出典(meeting / interview / voice-memo)。extractor の質問はこれ以外を持たない。 */
type FileSource = Extract<Source, { path: string }>;

/** JST(+09:00)の ISO 8601(§7.5)。源泉日(JST 深夜)を asked_at に写す。 */
function isoJst(d: Date): string {
  return `${new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
}

export interface OpenQuestionInput {
  /** 採番済みの q-ID(呼び出し側が makeId("q", 源泉日) で採る)。 */
  id: string;
  candidate: OpenQuestionCandidate;
  /** 元議事録の出典(repo/path/ref/lines)。本文へ記録する(QuestionLog に sources は無い)。 */
  source: FileSource;
  /** 起票時点 = 源泉日(議事録の日付・ADR-0026 D3)。パース不能時は呼び出し側が now() を渡す。 */
  askedAt: Date;
}

/** 未解決の問い候補 → questions/open/<id>-<slug>.md の FileChange。 */
export function materializeOpenQuestion(input: OpenQuestionInput): FileChange {
  const { id, candidate, source } = input;
  const frontmatter: QuestionLog = {
    id: id as QuestionLog["id"],
    asked_by: EXTRACTOR_ASKED_BY,
    asked_at: isoJst(input.askedAt),
    // channel は Discord 起票(§4.4)由来の必須フィールド。機械起票では「どこで問われたか」
    // = 源泉リポジトリを充てる(config 由来の値。ID・リポ名のハードコードはしない)。
    channel: source.repo,
    question: candidate.title,
    // bot への質問を経ていないため「bot が答えていない」= unanswered を規約値とする
    // (enum は unanswered | downvoted のみ・§4.4。機械起票用の値は増やさない)。
    bot_answer_quality: "unanswered",
    status: "open",
  };
  const body = [
    "",
    "## 質問の背景",
    "",
    candidate.body,
    "",
    "## 元議事録",
    "",
    `- repo: ${source.repo}`,
    `- path: ${source.path}`,
    ...(source.ref !== undefined ? [`- ref: ${source.ref}`] : []),
    ...(source.lines !== undefined ? [`- lines: ${source.lines}`] : []),
    "",
  ].join("\n");
  return {
    path: `questions/open/${id}-${slugify(candidate.title)}.md`,
    content: serializeEntry({ frontmatter, body }),
  };
}
