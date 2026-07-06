/**
 * フライホイールの後半(design.md §6.5 step5 + L505 / PR-D3b / ADR-0014)。
 * (A) ナレッジ化 PR が 👍 マージされたら(gap_pr 台帳を getPullRequest で確認)、質問を
 *     questions/open → answered へ移し(status:answered + resulting_kb・commitFiles の deletions で移動)、
 *     質問者へ通知する。これで「質問 → 依頼 → 回答 → ナレッジ化 → 通知」の1周が閉じる。
 * (B) status:asked のまま 7 日で回答者へリマインド1回、14 日で #stratum-ops に wontfix 候補を報告する
 *     (status 変更は人手・§6.5 L505)。二重送信は gap_reminder / gap_wontfix 台帳で防ぐ。
 * 全副作用は注入 seam。ユニットは fake のみ(鍵・ネットワーク・実 git 不要)。純判定は下記の純関数へ。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BotStore } from "@stratum/discord-bot/store";
import type { FileChange, GhClient } from "@stratum/gh-client";
import { parseEntry, type QuestionLog, serializeEntry } from "@stratum/kb-core";
import { z } from "zod";
import type { GapConfig } from "./config.js";
import type { SyncedKb } from "./kb-sync.js";
import type { Logger } from "./logger.js";

/** gap_pr 台帳(PR-D3a runAnswerIngestion が記録)。 */
export const gapPrPayloadSchema = z.object({
  prNumber: z.number().int().positive(),
  prRepo: z.string().min(1),
  items: z.array(z.object({ questionId: z.string().min(1), entryId: z.string().min(1) })).min(1),
});
export type GapPrPayload = z.infer<typeof gapPrPayloadSchema>;

/** asked_by("discord:<id>")→ Discord メンション。GitHub 名は解決不能なので null。 */
export function askerMention(askedBy: string): string | null {
  const m = /^discord:(\d+)$/.exec(askedBy);
  return m ? `<@${m[1]}>` : null;
}

export interface AnsweredMove {
  answeredPath: string;
  openPath: string;
  content: string;
  askedBy: string;
}

/** open の質問 raw → answered への移動(status:answered + resulting_kb を付す)。純関数。 */
export function buildAnsweredMove(
  questionRaw: string,
  entryId: string,
  questionId: string,
): AnsweredMove {
  const openPath = `questions/open/${questionId}.md`;
  const parsed = parseEntry(questionRaw, "question", openPath);
  const fm = parsed.frontmatter as unknown as QuestionLog;
  const moved = { ...fm, status: "answered", resulting_kb: entryId } as Record<string, unknown>;
  return {
    answeredPath: `questions/answered/${questionId}.md`,
    openPath,
    content: serializeEntry({ frontmatter: moved, body: parsed.body }),
    askedBy: fm.asked_by,
  };
}

/** 質問者への回答完了通知(依頼チャンネルへ)。 */
export function buildAnsweredNotify(
  mention: string | null,
  questionId: string,
  entryId: string,
): string {
  const head = mention ? `${mention} ` : "";
  return `${head}質問 (${questionId}) が回答され、ナレッジ (${entryId}) になりました。ありがとうございました!`;
}

/** asked_at からの経過日数(切り捨て)。 */
export function daysSince(askedAt: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(askedAt).getTime()) / 86_400_000);
}

export type ReminderVerdict = "none" | "remind" | "wontfix";

/** status:asked を経過日数で分類(§6.5 L505: 7 日リマインド・14 日 wontfix 報告)。 */
export function classifyQuestion(
  q: Pick<QuestionLog, "status" | "asked_at">,
  now: Date,
): ReminderVerdict {
  if (q.status !== "asked") return "none";
  const days = daysSince(q.asked_at, now);
  if (days >= 14) return "wontfix";
  if (days >= 7) return "remind";
  return "none";
}

/** リマインド文(依頼チャンネルへ再送。末尾 q-ID で返信捕捉が効く)。 */
export function buildReminderMessage(
  questionId: string,
  question: string,
  mention: string | null,
): string {
  const head = mention ? `${mention} ` : "";
  return [
    `${head}【リマインド】まだ回答を募集中の質問があります。`,
    `「${question}」`,
    "このメッセージに**返信**で教えてください。",
    `(${questionId})`,
  ].join("\n");
}

/** 14 日超の滞留質問レポート(#stratum-ops へ。status 変更は人手)。 */
export function buildWontfixReport(
  items: readonly { id: string; question: string; days: number }[],
): string {
  return [
    "⏳ 14 日以上未回答の質問です(wontfix 候補・status 変更は人手・§6.5 L505):",
    ...items.map((i) => `- (${i.id}) 「${i.question}」— ${i.days} 日経過`),
  ].join("\n");
}

export interface CloseDeps {
  config: GapConfig;
  store: BotStore;
  syncKb: () => Promise<SyncedKb>;
  gh: GhClient;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  /** questions/open/<id>.md の生テキスト(無ければ null)。 */
  readQuestionRaw: (kbRoot: string, questionId: string) => Promise<string | null>;
  /** questions/open の全 QuestionLog(リマインド走査用)。 */
  listOpenQuestions: (kbRoot: string) => Promise<QuestionLog[]>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** ファイル削除(answered へ移す際に open の実体を消してから validateRepo する)。 */
  removeFile: (absPath: string) => Promise<void>;
  /** Discord ID → GitHub 名の逆引き(assignee のメンション用)。 */
  discordForGithub: (github: string) => string | undefined;
  /** 依頼チャンネルへ投稿(質問者通知・リマインド)。 */
  postGap: (content: string) => Promise<void>;
  /** #stratum-ops へ投稿(wontfix 報告)。 */
  postOps: (content: string) => Promise<void>;
  now: () => Date;
  logger: Logger;
  real: boolean;
}

export interface CloseSummary {
  /** answered へ移した質問数。 */
  moved: number;
  remindersSent: number;
  wontfixReported: number;
  skipped: number;
  dryRun: boolean;
}

function safeJsonParse(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 台帳(type)に questionId が既に記録済みか(二重送信防止)。 */
function alreadyLedgered(store: BotStore, type: string, questionId: string): boolean {
  return store.listPendingActions(type).some((a) => {
    const p = safeJsonParse(a.payloadJson);
    return (
      typeof p === "object" &&
      p !== null &&
      (p as { questionId?: string }).questionId === questionId
    );
  });
}

function isoJst(d: Date): string {
  return `${new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
}

export async function runFlywheelClose(deps: CloseDeps): Promise<CloseSummary> {
  const { store, logger } = deps;
  const summary: CloseSummary = {
    moved: 0,
    remindersSent: 0,
    wontfixReported: 0,
    skipped: 0,
    dryRun: !deps.real,
  };
  const kb = await deps.syncKb();

  // --- (A) merged gap_pr → answered 移動 + 質問者通知 ---
  const ledger = store.listPendingActions("gap_pr").filter((a) => a.state === "pending");
  const moveFiles: FileChange[] = [];
  const moveDeletions: string[] = [];
  const askerNotifies: string[] = [];
  const ledgerDone: string[] = [];
  for (const action of ledger) {
    const parsed = gapPrPayloadSchema.safeParse(safeJsonParse(action.payloadJson));
    if (!parsed.success) {
      store.markActionDone(action.id);
      summary.skipped += 1;
      continue;
    }
    const { prRepo, prNumber, items } = parsed.data;
    const pr = await deps.gh.getPullRequest(prRepo, prNumber);
    if (!pr.merged) {
      if (pr.state === "closed") {
        // マージされず閉じられた(却下)。台帳は畳む(質問は open のままリマインド対象)。
        logger.warn("ナレッジ化 PR がマージされず閉じられました", { prNumber });
        store.markActionDone(action.id);
      }
      continue; // open のままなら次回に持ち越し
    }
    for (const item of items) {
      const raw = await deps.readQuestionRaw(kb.absDir, item.questionId);
      if (raw === null) continue; // 既に移動済み
      const move = buildAnsweredMove(raw, item.entryId, item.questionId);
      await deps.writeFile(join(kb.absDir, move.answeredPath), move.content);
      await deps.removeFile(join(kb.absDir, move.openPath)); // validateRepo が重複 id を弾くため実体を消す
      moveFiles.push({ path: move.answeredPath, content: move.content });
      moveDeletions.push(move.openPath);
      askerNotifies.push(
        buildAnsweredNotify(askerMention(move.askedBy), item.questionId, item.entryId),
      );
    }
    ledgerDone.push(action.id);
  }

  // --- (B) リマインド / wontfix 走査(A で open から抜けた分は対象外)---
  const now = deps.now();
  const open = await deps.listOpenQuestions(kb.absDir);
  const reminders: { id: string; message: string }[] = [];
  const wontfix: { id: string; question: string; days: number }[] = [];
  for (const q of open) {
    const verdict = classifyQuestion(q, now);
    if (verdict === "remind" && !alreadyLedgered(store, "gap_reminder", q.id)) {
      const mention = q.assignee ? mentionFor(deps, q.assignee) : null;
      reminders.push({ id: q.id, message: buildReminderMessage(q.id, q.question, mention) });
    } else if (verdict === "wontfix" && !alreadyLedgered(store, "gap_wontfix", q.id)) {
      wontfix.push({ id: q.id, question: q.question, days: daysSince(q.asked_at, now) });
    }
  }

  if (!deps.real) {
    logger.info("dry-run: 移動も通知もしません(GAP_TRACKER_REAL 未設定)。", {
      moves: moveFiles.length,
      reminders: reminders.length,
      wontfix: wontfix.length,
    });
    summary.moved = moveFiles.length;
    summary.remindersSent = reminders.length;
    summary.wontfixReported = wontfix.length;
    return summary;
  }

  // (A) 移動を 1 コミット(open 削除 + answered 追加)。push 前に validateRepo(ADR-0004 D2)。
  if (moveFiles.length > 0) {
    const report = await deps.validate(kb.absDir);
    if (!report.ok) {
      logger.error("validateRepo 失敗。answered 移動を commit しません。", {
        problems: report.problems.length,
      });
    } else {
      await deps.gh.commitFiles({
        repo: deps.config.kb_repo,
        branch: deps.config.base_branch,
        message: `chore(gap): move ${moveFiles.length} question(s) to answered`,
        files: moveFiles,
        deletions: moveDeletions,
      });
      for (const content of askerNotifies) await deps.postGap(content);
      for (const id of ledgerDone) store.markActionDone(id);
      summary.moved = moveFiles.length;
    }
  } else {
    // 却下 PR 等で移動は無いが台帳を畳んだケース。
    for (const id of ledgerDone) store.markActionDone(id);
  }

  // (B) リマインド送信 + 台帳記録(二重送信防止)。
  for (const r of reminders) {
    await deps.postGap(r.message);
    store.queueAction(ledgerEntry("gap_reminder", r.id, now));
    summary.remindersSent += 1;
  }
  if (wontfix.length > 0) {
    await deps.postOps(buildWontfixReport(wontfix));
    for (const w of wontfix) store.queueAction(ledgerEntry("gap_wontfix", w.id, now));
    summary.wontfixReported = wontfix.length;
  }
  return summary;
}

function mentionFor(deps: CloseDeps, github: string): string | null {
  const discord = deps.discordForGithub(github);
  return discord ? `<@${discord}>` : null;
}

function ledgerEntry(type: string, questionId: string, now: Date) {
  return {
    id: randomUUID(),
    type,
    queryId: null,
    payloadJson: JSON.stringify({ questionId }),
    state: "done",
    createdAt: isoJst(now),
  };
}
