/**
 * 質問ログの組み立てと依頼文(design.md §6.5 step1-3)。全部純関数(ユニットは fake 不要)。
 * - 質問エントリは kb-core の QuestionLog(§4.4)へ写す。型の再定義はしない(CLAUDE.md §12.2)。
 * - 依頼文は §6.5 L502 の決定論テンプレ(LLM を使わない。低摩擦の定型文が仕様)。
 * - 冪等キー: 本文に `query-id:` 行を埋め、既存 questions/ に同じ UUID があれば再作成しない。
 */
import type { QueryRecord } from "@stratum/discord-bot/store";
import type { QuestionLog } from "@stratum/kb-core";
import {
  type Members,
  discordForGithub as membersDiscordForGithub,
  githubForDiscord as membersGithubForDiscord,
} from "@stratum/kb-core";
import type { Assignee } from "./config.js";

/** 本文に埋める冪等キー行(markActionDone 失敗時の二重 commit 防止)。 */
export function queryIdLine(queryId: string): string {
  return `query-id: ${queryId}`;
}

/**
 * discord→github 解決(ADR-0017 D3 既知課題の付け替え・質問者の asked_by 等)。
 * KB `_meta/members.yaml`(全員名簿・唯一の正)を優先し、未登載は assignees
 * (依頼プール。依頼メンション用に discord ID を保持する別概念)へフォールバックする。
 * assignees プール自体の統合はしない(ADR-0017: selectAssignee の母集団を広げないため)。
 */
export function resolveGithubForDiscord(
  members: Members,
  assignees: readonly Assignee[],
  discordId: string,
): string | undefined {
  return (
    membersGithubForDiscord(members, discordId) ??
    assignees.find((a) => a.discord === discordId)?.github
  );
}

/**
 * github→discord 逆引き(ADR-0017 D3 が名指しした discordForGithub 側の付け替え)。
 * members 優先 + assignees フォールバック。回答完了通知・リマインドのメンション解決に使う。
 * これが無いと、asked_by が members 由来の GitHub 名に変わった質問者への通知が
 * メンション無しに落ちる(§6.5 step5 の退行)。
 */
export function resolveDiscordForGithub(
  members: Members,
  assignees: readonly Assignee[],
  github: string,
): string | undefined {
  return (
    membersDiscordForGithub(members, github) ?? assignees.find((a) => a.github === github)?.discord
  );
}

/** questions/ 配下の生テキスト群に queryId が既出か(冪等ガード)。 */
export function containsQueryId(rawEntries: readonly string[], queryId: string): boolean {
  const needle = queryIdLine(queryId);
  return rawEntries.some((raw) => raw.includes(needle));
}

/** bot の回答状態 → §4.4 bot_answer_quality。 */
export function toBotAnswerQuality(q: QueryRecord): "unanswered" | "downvoted" {
  return q.feedback === "down" ? "downvoted" : "unanswered";
}

export interface BuiltQuestion {
  frontmatter: QuestionLog;
  body: string;
  /** questions/open/<id>.md(repo 相対)。 */
  path: string;
}

/**
 * NOT_FOUND/👎 クエリ → QuestionLog エントリ(§4.4)。
 * asked_by は GitHub 名が引ければそれ、無ければ "discord:<id>"(§14 #8 未整備の間のフォールバック)。
 * status は "asked"(同一 run で依頼まで送る前提。送信失敗はリマインド(PR-D3)が回収する)。
 */
export function buildQuestion(
  id: string,
  query: QueryRecord,
  assignee: Assignee | null,
  githubForDiscord: (discordId: string) => string | undefined,
): BuiltQuestion {
  const askedBy = githubForDiscord(query.discordUserId) ?? `discord:${query.discordUserId}`;
  const frontmatter: QuestionLog = {
    id: id as QuestionLog["id"],
    asked_by: askedBy,
    asked_at: query.createdAt,
    channel: query.discordChannelId,
    question: query.question,
    bot_answer_quality: toBotAnswerQuality(query),
    status: assignee ? "asked" : "open",
    ...(assignee ? { assignee: assignee.github } : {}),
  };
  const body = [
    "",
    "## Bot の回答記録",
    "",
    query.answer && query.answer.length > 0 ? query.answer : "(出典が見つからず未回答)",
    "",
    `${queryIdLine(query.id)}`,
    "",
  ].join("\n");
  return { frontmatter, body, path: `questions/open/${id}.md` };
}

/** ISO 週キー(週3件/人のレート制限バケット・§6.5 L501)。例 "2026-W28"。 */
export function isoWeekKey(d: Date): string {
  // ISO 8601: 週は月曜始まり・その週の木曜が属する年が ISO 年。
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * 回答者選定(§6.5 step2 / §4.4 L302)。expertise.yaml 由来の優先リスト(rankByExpertise)が
 * あれば「その順 ∩ assignees」を先に試し、無ければ(または優先者が全員週上限なら)従来の
 * ラウンドロビンへフォールバック。assignees は「依頼を振ってよい人の curated プール」なので、
 * expertise に載っていても assignees 外の人には依頼しない(ADR-0017 D3 の整理)。
 * tryReserve が週3件/人の予約(BotStore.hitRateLimit を写像)で、全員が上限なら null
 * (質問は status:open のまま・依頼なし)。
 */
export function selectAssignee(
  assignees: readonly Assignee[],
  startIndex: number,
  tryReserve: (github: string) => boolean,
  preferred: readonly string[] = [],
): Assignee | null {
  const tried = new Set<string>();
  for (const name of preferred) {
    const a = assignees.find((x) => x.github === name);
    if (a === undefined || tried.has(a.github)) continue;
    tried.add(a.github);
    if (tryReserve(a.github)) return a;
  }
  for (let i = 0; i < assignees.length; i += 1) {
    const a = assignees[(startIndex + i) % assignees.length];
    if (a === undefined || tried.has(a.github)) continue;
    tried.add(a.github);
    if (tryReserve(a.github)) return a;
  }
  return null;
}

/** 依頼メッセージ(§6.5 L502 テンプレ + 返信キーの q-ID)。 */
export function buildRequestMessage(
  assignee: Assignee,
  askerLabel: string,
  question: string,
  questionId: string,
): string {
  return [
    `<@${assignee.discord}> さん、${askerLabel} さんが「${question}」を探していました。`,
    "1〜2 文で教えてもらえますか? このメッセージに**返信**するだけで OK です。",
    `(${questionId})`,
  ].join("\n");
}
