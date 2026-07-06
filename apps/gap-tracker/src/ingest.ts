/**
 * gap 回答の取り込み(design.md §6.5 step4-5 / PR-D3a / ADR-0014)。
 * bot(PR-D2)が pending_actions(gap_answer)に積んだ回答を読み、LLM でナレッジ草案 → KnowledgeEntry →
 * KB clone に staging → validateRepo → **1 run 1 PR**(gh-client.createPullRequest)→ #stratum-ops に
 * webhook 通知(§6.3 の 👍 代理マージが拾う)→ D3b 用の gap_pr 台帳を記録 → gap_answer を消費(markActionDone)。
 * 全副作用は注入 seam(store/gh/git/fs/draft/webhook/clock)。ユニットは fake のみ。
 *
 * なぜ 1 run 1 PR か: 各エントリは `_meta/id-counter.json` を進めるため、回答ごとに別 PR にすると
 * カウンタが同一 base から競合して 3-way マージ衝突する。extractor(§6.3)と同じくまとめて 1 PR にする。
 * 冪等性: markActionDone(消費)が主。ブランチ名は回答集合のハッシュで決定的にし、途中失敗した run の
 * 再実行では createPullRequest が CONFLICT(ブランチ既存)→ 消費せず警告(重複 PR を作らない)。
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BotStore } from "@stratum/discord-bot/store";
import type { FileChange, GhClient } from "@stratum/gh-client";
import { allocateId, type IdCounterStore, parseEntry, serializeEntry } from "@stratum/kb-core";
import { type AnswerEntryCandidate, buildAnswerEntry, gapAnswerPayloadSchema } from "./answer.js";
import type { GapConfig } from "./config.js";
import type { DraftInput } from "./draft.js";
import type { SyncedKb } from "./kb-sync.js";
import type { Logger } from "./logger.js";

export interface IngestDeps {
  config: GapConfig;
  store: BotStore;
  syncKb: () => Promise<SyncedKb>;
  gh: GhClient;
  makeIdStore: (kbRoot: string) => IdCounterStore;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  /** questions/open/<id>.md の生テキスト(無ければ null)。 */
  readQuestionRaw: (kbRoot: string, questionId: string) => Promise<string | null>;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** knowledge/ 直下の既存 domain 一覧(乱立抑制のヒント)。 */
  listDomains: (kbRoot: string) => Promise<string[]>;
  /** LLM 草案(seam。既定は draftEntry を .value に剥がしたもの)。 */
  draft: (input: DraftInput) => Promise<AnswerEntryCandidate>;
  /** #stratum-ops への通知(実装は Discord webhook。空 URL は no-op)。 */
  postOps: (content: string) => Promise<void>;
  /** Discord ID → GitHub 名(owner の写像。未登載は undefined)。 */
  githubForDiscord: (discordId: string) => string | undefined;
  now: () => Date;
  logger: Logger;
  /** true で実 PR + 実通知。false は計画ログのみ(既定)。 */
  real: boolean;
}

/** gap_pr 台帳の1項目(D3b が questions を answered へ移すのに使う)。 */
export interface IngestItem {
  questionId: string;
  entryId: string;
}

export interface IngestSummary {
  /** ナレッジ化した回答数(dry-run では予定数)。 */
  drafted: number;
  /** 作成した PR 数(0 または 1)。 */
  prCreated: number;
  /** payload 不正・質問が open に無い等で読み飛ばした数。 */
  skipped: number;
  dryRun: boolean;
}

/** 回答集合(questionId のソート)から決定的なブランチ名を作る(冪等性)。 */
export function answersBranch(questionIds: readonly string[]): string {
  const key = [...questionIds].sort().join(",");
  const h = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return `gap/answers-${h}`;
}

/** JST(+09:00)の ISO 8601(§7.5)。pending_actions.createdAt 用。 */
function isoJst(d: Date): string {
  return `${new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
}

function safeJsonParse(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function runAnswerIngestion(deps: IngestDeps): Promise<IngestSummary> {
  const { store, logger } = deps;
  const pending = store.listPendingActions("gap_answer").filter((a) => a.state === "pending");
  const summary: IngestSummary = { drafted: 0, prCreated: 0, skipped: 0, dryRun: !deps.real };
  if (pending.length === 0) {
    logger.info("未処理の gap 回答はありません。");
    return summary;
  }

  const kb = await deps.syncKb();
  const idStore = deps.makeIdStore(kb.absDir);
  const existingDomains = await deps.listDomains(kb.absDir);

  const files: FileChange[] = [];
  const items: IngestItem[] = [];
  const doneIds: string[] = [];
  const notifyLines: string[] = [];

  for (const action of pending) {
    const parsed = gapAnswerPayloadSchema.safeParse(safeJsonParse(action.payloadJson));
    if (!parsed.success) {
      logger.warn("gap_answer の payload が不正なためスキップ", { actionId: action.id });
      store.markActionDone(action.id);
      summary.skipped += 1;
      continue;
    }
    const payload = parsed.data;
    const raw = await deps.readQuestionRaw(kb.absDir, payload.questionId);
    if (raw === null) {
      // 既に answered/wontfix へ移動済み or 存在しない → 再処理しても直らない。消費する。
      logger.warn("questions/open に対象が無いためスキップ", { questionId: payload.questionId });
      store.markActionDone(action.id);
      summary.skipped += 1;
      continue;
    }
    const question = parseEntry(raw, "question", `questions/open/${payload.questionId}.md`);
    const candidate = await deps.draft({
      question: question.frontmatter.question,
      answer: payload.content,
      cwd: kb.absDir,
      existingDomains,
    });
    const owner = deps.githubForDiscord(payload.authorId) ?? "unassigned";
    const id = await allocateId("kb", idStore, { now: deps.now() });
    const built = buildAnswerEntry(id, candidate, payload.messageUrl, owner, deps.now());
    const content = serializeEntry({ frontmatter: built.frontmatter, body: built.body });
    await deps.writeFile(join(kb.absDir, built.path), content); // validateRepo がディスクを読む
    files.push({ path: built.path, content });
    items.push({ questionId: payload.questionId, entryId: id });
    doneIds.push(action.id);
    notifyLines.push(`- ${payload.questionId} → ${id}(${built.frontmatter.domain})`);
  }

  if (files.length === 0) {
    logger.info("PR 対象の回答がありません(全件スキップ)。", { skipped: summary.skipped });
    return summary;
  }

  // 採番ファイルを PR に含める(id が主リポで一意になるように・extractor と同じ)。
  const counter = await deps
    .readFile(join(kb.absDir, "_meta", "id-counter.json"))
    .catch(() => null);
  if (counter !== null) files.push({ path: "_meta/id-counter.json", content: counter });

  const report = await deps.validate(kb.absDir);
  if (!report.ok) {
    logger.error("validateRepo が失敗。PR を作りません(ADR-0004 D2)。", {
      problems: report.problems.length,
    });
    return { ...summary, drafted: 0, prCreated: 0 };
  }

  summary.drafted = items.length;
  if (!deps.real) {
    logger.info("dry-run: PR も通知もしません(GAP_TRACKER_REAL 未設定)。", {
      entries: items.map((i) => i.entryId),
      files: files.length,
    });
    return summary;
  }

  const head = answersBranch(items.map((i) => i.questionId));
  const title = `docs(kb): ${items.length} 件の gap 回答をナレッジ化`;
  const body = [
    "gap-tracker が回答者の返信からナレッジ記事を起こしました(§6.5 step4)。",
    "",
    ...notifyLines,
    "",
    "内容を確認し、#stratum-ops で 👍 すると Bot が代理マージします(§6.3)。",
  ].join("\n");
  const pr = await deps.gh.createPullRequest({
    repo: deps.config.kb_repo,
    head,
    base: deps.config.base_branch,
    title,
    body,
    files,
  });
  summary.prCreated = 1;

  // #stratum-ops に webhook 投稿(本文の PR URL を bot の 👍 代理マージが拾う・§6.3)。
  await deps.postOps(
    [`📚 gap 回答をナレッジ化しました: ${pr.url}`, ...notifyLines, "👍 で承認マージ"].join("\n"),
  );

  // D3b(マージ検出 → answered 移動)のための台帳。merged になったら questions を answered へ移す。
  store.queueAction({
    id: randomUUID(),
    type: "gap_pr",
    queryId: null,
    payloadJson: JSON.stringify({ prNumber: pr.number, prRepo: deps.config.kb_repo, items }),
    state: "pending",
    createdAt: isoJst(deps.now()),
  });
  for (const actionId of doneIds) store.markActionDone(actionId);
  logger.info("gap 回答を PR 化しました。", {
    prNumber: pr.number,
    entries: items.length,
    skipped: summary.skipped,
  });
  return summary;
}
