/**
 * gap-tracker オーケストレータ(design.md §6.5 step1-3 / ADR-0014)。
 * bot の SQLite から未処理の NOT_FOUND/👎 を取得 → QuestionLog を staging → validateRepo →
 * questions/open へ 1 コミット(commitFiles・PR を経ない=§6.5 の意図)→ 回答者へ依頼(webhook)→
 * markActionDone。全副作用は注入 seam(store/gh/git/fs/webhook/clock)。ユニットは fake のみ。
 * 実 commit/送信は real フラグ時のみ(既定 dry-run)。回答の取り込みとリマインドは PR-D3。
 *
 * 冪等性(2段): (1) markActionDone(消費の主機構)、(2) 本文の query-id 行スキャン
 * (commit 成功後 markActionDone 前に落ちた場合の二重 commit 防止)。
 * 本番は kb_url を設定する(sync が fetch+reset+clean で毎回クリーンにする。reset --hard だけでは
 * 未追跡の staging 残骸が残り、冪等スキャンが誤認して queue を消費する(VM 実害 2026-07-22)。
 * url 無しの事前 checkout は残骸掃除が働かないため開発用)。
 */
import { join } from "node:path";
import type { BotStore } from "@stratum/discord-bot/store";
import type { FileChange, GhClient } from "@stratum/gh-client";
import {
  allocateId,
  type ExpertiseMap,
  type IdCounterStore,
  parseExpertiseMap,
  serializeEntry,
} from "@stratum/kb-core";
import type { Assignee, GapConfig } from "./config.js";
import { rankByExpertise } from "./expertise.js";
import type { SyncedKb } from "./kb-sync.js";
import type { Logger } from "./logger.js";
import { buildQuestion, buildRequestMessage, containsQueryId, selectAssignee } from "./question.js";

export interface RunDeps {
  config: GapConfig;
  /** bot の運用ストア(ADR-0014 D2: 同一 VM の bot.db)。 */
  store: BotStore;
  syncKb: () => Promise<SyncedKb>;
  gh: GhClient;
  makeIdStore: (kbRoot: string) => IdCounterStore;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  /** questions/ 配下の既存エントリ raw 一覧(冪等スキャン用。無ければ [])。 */
  listQuestionRaws: (kbRoot: string) => Promise<string[]>;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** 依頼の投稿(§6.5 step3。実装は Discord webhook)。 */
  postRequest: (content: string) => Promise<void>;
  /** 週3件/人の予約(§6.5 L501)。true=割当可。real 時は BotStore.hitRateLimit、dry-run はローカル。 */
  reserveAssignee: (github: string) => boolean;
  /** Discord ID → GitHub 名(gap.yaml assignees から。未登載は undefined)。 */
  githubForDiscord: (discordId: string) => string | undefined;
  now: () => Date;
  logger: Logger;
  /** true で実 commit + 実依頼。false は計画ログのみ(既定)。 */
  real: boolean;
}

export interface RunSummary {
  /** commit した質問数(dry-run では commit 予定数)。 */
  committed: number;
  /** 依頼を送った数(assignee が付いた数)。 */
  requested: number;
  /** 全員が週上限で assignee 無し(status:open のまま)の数。 */
  unassigned: number;
  /** 冪等スキャン・orphan で読み飛ばした数。 */
  skipped: number;
  dryRun: boolean;
}

export async function runGapTracker(deps: RunDeps): Promise<RunSummary> {
  const { config, store, logger } = deps;
  const pending = store
    .listPendingActions("question_queue")
    .filter((a) => a.state === "pending" && a.queryId !== null);
  const summary: RunSummary = {
    committed: 0,
    requested: 0,
    unassigned: 0,
    skipped: 0,
    dryRun: !deps.real,
  };
  if (pending.length === 0) {
    logger.info("未処理の質問キューはありません。");
    return summary;
  }

  const kb = await deps.syncKb();
  const raws = await deps.listQuestionRaws(kb.absDir);
  const idStore = deps.makeIdStore(kb.absDir);

  // §4.4 L302: expertise.yaml があれば担当選定に使う(未生成・読取不可は従来ラウンドロビン)。
  // parse 失敗も warn に留めて続行する(担当選定は依頼の付加価値であり、質問 commit を止めない)。
  let expertise: ExpertiseMap | null = null;
  try {
    expertise = parseExpertiseMap(
      await deps.readFile(join(kb.absDir, "expertise", "expertise.yaml")),
    );
  } catch {
    logger.info(
      "expertise.yaml が読めないため従来のラウンドロビンで選定します(Phase 4 生成前は正常)。",
    );
  }

  const files: FileChange[] = [];
  const requests: string[] = [];
  const doneIds: string[] = [];
  const questionIds: string[] = [];
  // ラウンドロビン起点は日替わり(状態を持たずに偏りを均す)。
  let rr = Math.floor(deps.now().getTime() / 86_400_000) % Math.max(1, config.assignees.length);

  for (const action of pending) {
    const query = action.queryId !== null ? store.getQuery(action.queryId) : undefined;
    if (query === undefined) {
      // queries 行が無い orphan は再処理しても直らない → done にして数える。
      logger.warn("queries に対応行が無いためスキップ", { actionId: action.id });
      store.markActionDone(action.id);
      summary.skipped += 1;
      continue;
    }
    if (containsQueryId(raws, query.id)) {
      // 既に commit 済み(markActionDone 前に落ちた残骸)。消費だけ進める。
      store.markActionDone(action.id);
      summary.skipped += 1;
      continue;
    }
    const preferred = expertise === null ? [] : rankByExpertise(query.question, expertise);
    const assignee: Assignee | null = selectAssignee(
      config.assignees,
      rr,
      deps.reserveAssignee,
      preferred,
    );
    rr += 1;
    const id = await allocateId("q", idStore, { now: deps.now() });
    const built = buildQuestion(id, query, assignee, deps.githubForDiscord);
    files.push({
      path: built.path,
      content: serializeEntry({ frontmatter: built.frontmatter, body: built.body }),
    });
    questionIds.push(id);
    doneIds.push(action.id);
    if (assignee) {
      const asker = deps.githubForDiscord(query.discordUserId) ?? `<@${query.discordUserId}>`;
      requests.push(buildRequestMessage(assignee, asker, query.question, id));
      summary.requested += 1;
    } else {
      logger.warn("全回答者が週上限のため assignee 無し(status:open)", { questionId: id });
      summary.unassigned += 1;
    }
  }

  if (files.length === 0) {
    logger.info("commit 対象がありません(全件スキップ)。", { skipped: summary.skipped });
    return summary;
  }

  // clone に staging(validateRepo がディスクを読む)+ 採番ファイルを commit に含める(extractor と同じ)。
  for (const f of files) {
    await deps.writeFile(join(kb.absDir, f.path), f.content);
  }
  const counter = await deps
    .readFile(join(kb.absDir, "_meta", "id-counter.json"))
    .catch(() => null);
  if (counter !== null) files.push({ path: "_meta/id-counter.json", content: counter });

  const report = await deps.validate(kb.absDir);
  if (!report.ok) {
    logger.error("validateRepo が失敗。commit しません(ADR-0004 D2 / ADR-0014 D4)。", {
      problems: report.problems.length,
    });
    return { ...summary, committed: 0, requested: 0 };
  }

  summary.committed = questionIds.length;
  if (!deps.real) {
    logger.info("dry-run: commit も依頼送信もしません(GAP_TRACKER_REAL 未設定)。", {
      questions: questionIds,
      files: files.length,
      requests: requests.length,
    });
    return summary;
  }

  await deps.gh.commitFiles({
    repo: config.kb_repo,
    branch: config.base_branch,
    message: `chore(gap): add ${questionIds.length} question(s) ${questionIds.join(", ")}`,
    files,
  });
  for (const content of requests) {
    await deps.postRequest(content);
  }
  for (const id of doneIds) {
    store.markActionDone(id);
  }
  logger.info("質問ログを commit し依頼を送信しました。", {
    committed: summary.committed,
    requested: summary.requested,
    unassigned: summary.unassigned,
  });
  return summary;
}
