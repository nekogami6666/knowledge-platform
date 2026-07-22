/**
 * freshness-checker オーケストレータ(design.md §6.7 / ADR-0019)。
 * KB clone を同期 → 期限超過の active エントリを列挙 → owner 別 1 日 N 件で
 * pending_actions(type: "freshness")へ積む(DM 送信と 👍✏️🗑 の応答処理は bot 側)。
 * 併せて、積んでから stale_after_days 無応答のものを status: stale へ一括降格
 * (staging → validateRepo → commitFiles 1 コミット・gap-tracker と同型・ADR-0019 D3/D4)。
 *
 * 冪等性(ADR-0019 D4): 生きている(state !== "done")freshness アクションがあるエントリは
 * 再投入しない。owner→Discord は KB の _meta/members.yaml で解決(ADR-0017 D3)。
 * 未登載 owner は warn + スキップ(日次予算を消費しない)。
 * 全副作用は注入 seam(store/gh/git/fs/webhook/clock)。dry-run(既定)は store にも remote にも
 * 書かない(clone への staging は validateRepo 用で、次回 sync の reset --hard + clean -fd で消える。
 * reset --hard 単体は未追跡ファイルを消さない — gap-tracker の VM 実害 2026-07-22)。
 */
import { join } from "node:path";
import {
  FRESHNESS_ACTION_TYPE,
  type FreshnessPayload,
  parseFreshnessPayload,
} from "@stratum/discord-bot/freshness";
import type { BotStore, PendingAction } from "@stratum/discord-bot/store";
import type { FileChange, GhClient } from "@stratum/gh-client";
import {
  discordForGithub,
  type Members,
  parseMembers,
  safeParseEntry,
  serializeEntry,
} from "@stratum/kb-core";
import type { FreshnessConfig } from "./config.js";
import type { SyncedKb } from "./kb-sync.js";
import type { Logger } from "./logger.js";
import { collectOverdue, type KbFile } from "./overdue.js";

/** JST(+09:00)の ISO 8601(§7.5。discord-bot/src/time.ts と同じ変換・logger と同様の複製 TODO)。 */
export function isoJst(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

/** JST の日付キー(YYYY-MM-DD。日次予算の rate_limits ウィンドウ識別子)。 */
export function jstDateKey(date: Date): string {
  return isoJst(date).slice(0, 10);
}

export interface RunDeps {
  config: FreshnessConfig;
  /** bot の運用ストア(ADR-0014 D2: 同一 VM の bot.db)。 */
  store: BotStore;
  syncKb: () => Promise<SyncedKb>;
  gh: GhClient;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  /** knowledge/ 配下の .md 一覧(path は KB リポ相対)。 */
  listKnowledgeFiles: (kbRoot: string) => Promise<KbFile[]>;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** stale 降格の報告(実装は #stratum-ops webhook)。 */
  postOps: (content: string) => Promise<void>;
  /** 1 人 1 日 N 件の予約。true=投入可。real 時は BotStore.hitRateLimit、dry-run はローカル。 */
  reserveOwner: (discordId: string, dateKey: string) => boolean;
  makeId: () => string;
  now: () => Date;
  logger: Logger;
  /** true で実キュー投入 + 実 commit。false は計画ログのみ(既定)。 */
  real: boolean;
}

export interface RunSummary {
  /** pending_actions へ積んだ数(dry-run では投入予定数)。 */
  queued: number;
  /** stale へ降格した数(dry-run では降格予定数)。 */
  staled: number;
  /** 生きているアクションがあるため再投入しなかった数。 */
  skippedLive: number;
  /** owner が members.yaml 未登載でスキップした数。 */
  skippedNoMember: number;
  /** owner の日次上限でスキップした数。 */
  skippedRateLimited: number;
  dryRun: boolean;
}

interface LiveAction {
  action: PendingAction;
  payload: FreshnessPayload;
}

/** _meta/members.yaml を読む。無い/壊れているは「空の対応表 + 警告」に落として続行(ADR-0017 D3)。 */
async function loadMembers(deps: RunDeps, kbRoot: string): Promise<Members> {
  const path = join("_meta", "members.yaml");
  try {
    return parseMembers(await deps.readFile(join(kbRoot, path)), path);
  } catch {
    deps.logger.warn("members.yaml が読めないため owner への DM 投入は全件スキップされます", {
      path,
    });
    return { members: [] };
  }
}

/** 生きている freshness アクションを payload 検証付きで返す。壊れた payload は warn(+ real なら消費)。 */
function listLiveActions(deps: RunDeps): LiveAction[] {
  const out: LiveAction[] = [];
  for (const action of deps.store.listPendingActions(FRESHNESS_ACTION_TYPE)) {
    if (action.state === "done") continue;
    const payload = parseFreshnessPayload(action.payloadJson);
    if (payload === null) {
      // 再処理しても直らない orphan。dry-run では store に書かない(warn のみ)。
      deps.logger.warn("payload が不正な freshness アクションをスキップ", { actionId: action.id });
      if (deps.real) deps.store.markActionDone(action.id);
      continue;
    }
    out.push({ action, payload });
  }
  return out;
}

/**
 * stale_after_days 無応答のアクション → 対象エントリを status: stale へ降格(1 コミット)。
 * 降格対象の path 集合を返す(同ランでの再投入除外用)。
 */
async function demoteUnanswered(
  deps: RunDeps,
  kb: SyncedKb,
  expired: LiveAction[],
  summary: RunSummary,
): Promise<Set<string>> {
  const demoted = new Set<string>();
  if (expired.length === 0) return demoted;
  const { config, store, logger } = deps;
  const files: FileChange[] = [];
  const doneIds: string[] = [];
  for (const { action, payload } of expired) {
    let raw: string;
    try {
      raw = await deps.readFile(join(kb.absDir, payload.path));
    } catch {
      // エントリが移動/削除済み。追いかけない(消費だけ進める)。
      logger.warn("対象エントリが見つからないため降格をスキップ", { path: payload.path });
      if (deps.real) store.markActionDone(action.id);
      continue;
    }
    const parsed = safeParseEntry(raw, "knowledge", payload.path);
    if (!parsed.ok || parsed.entry.frontmatter.status !== "active") {
      // 既に人手で更新/降格済み(active でない)なら消費だけ進める。
      logger.info("エントリが active でないため降格不要", { path: payload.path });
      if (deps.real) store.markActionDone(action.id);
      continue;
    }
    files.push({
      path: payload.path,
      content: serializeEntry({
        frontmatter: { ...parsed.entry.frontmatter, status: "stale" },
        body: parsed.entry.body,
      }),
    });
    doneIds.push(action.id);
    demoted.add(payload.path);
  }
  if (files.length === 0) return demoted;

  // clone に staging(validateRepo がディスクを読む)→ 検証 → 1 コミット(ADR-0004 D2 / ADR-0019 D3)。
  for (const f of files) {
    await deps.writeFile(join(kb.absDir, f.path), f.content);
  }
  const report = await deps.validate(kb.absDir);
  if (!report.ok) {
    logger.error("validateRepo が失敗。stale 降格を commit しません(ADR-0004 D2)。", {
      problems: report.problems.length,
    });
    demoted.clear();
    return demoted;
  }
  summary.staled = files.length;
  if (!deps.real) {
    logger.info("dry-run: stale 降格を commit しません(FRESHNESS_REAL 未設定)。", {
      paths: files.map((f) => f.path),
    });
    return demoted;
  }
  await deps.gh.commitFiles({
    repo: config.kb_repo,
    branch: config.base_branch,
    message: `chore(freshness): ${config.stale_after_days}日無応答の ${files.length} 件を stale へ降格`,
    files,
  });
  for (const id of doneIds) {
    store.markActionDone(id);
  }
  await deps.postOps(
    [
      `⏳ 鮮度確認に ${config.stale_after_days} 日応答がなかった ${files.length} 件を status: stale へ降格しました。`,
      ...files.map((f) => `- ${f.path}`),
    ].join("\n"),
  );
  return demoted;
}

export async function runFreshnessChecker(deps: RunDeps): Promise<RunSummary> {
  const { config, store, logger } = deps;
  const summary: RunSummary = {
    queued: 0,
    staled: 0,
    skippedLive: 0,
    skippedNoMember: 0,
    skippedRateLimited: 0,
    dryRun: !deps.real,
  };
  const now = deps.now();
  const today = jstDateKey(now);

  const kb = await deps.syncKb();
  const kbFiles = await deps.listKnowledgeFiles(kb.absDir);
  const members = await loadMembers(deps, kb.absDir);

  // 生きているアクションを「無応答期限切れ(→降格)」と「応答待ち(→再投入しない)」に分ける。
  const staleThresholdMs = config.stale_after_days * 86_400_000;
  const live = listLiveActions(deps);
  const expired = live.filter(
    ({ action }) => now.getTime() - new Date(action.createdAt).getTime() >= staleThresholdMs,
  );
  const waitingPaths = new Set(live.filter((l) => !expired.includes(l)).map((l) => l.payload.path));
  const demotedPaths = await demoteUnanswered(deps, kb, expired, summary);

  // 期限超過エントリを owner 別日次予算内で投入する(古い順・ADR-0019 D2)。
  for (const o of collectOverdue(kbFiles, today, logger)) {
    if (waitingPaths.has(o.path) || demotedPaths.has(o.path)) {
      summary.skippedLive += 1;
      continue;
    }
    const discord = discordForGithub(members, o.entry.owner);
    if (discord === undefined) {
      logger.warn("owner が members.yaml 未登載のため確認 DM を積めません", {
        path: o.path,
        owner: o.entry.owner,
      });
      summary.skippedNoMember += 1;
      continue;
    }
    if (!deps.reserveOwner(discord, today)) {
      summary.skippedRateLimited += 1;
      continue;
    }
    const payload: FreshnessPayload = {
      entryId: o.entry.id,
      path: o.path,
      title: o.entry.title,
      ownerGithub: o.entry.owner,
      ownerDiscord: discord,
      lastVerified: o.entry.last_verified,
    };
    if (deps.real) {
      store.queueAction({
        id: deps.makeId(),
        type: FRESHNESS_ACTION_TYPE,
        queryId: null,
        payloadJson: JSON.stringify(payload),
        state: "pending",
        createdAt: isoJst(now),
      });
    } else {
      logger.info("dry-run: 確認 DM を投入予定(FRESHNESS_REAL 未設定)。", {
        path: o.path,
        owner: o.entry.owner,
        dueDate: o.dueDate,
      });
    }
    summary.queued += 1;
  }

  logger.info("freshness-checker 完了", { ...summary });
  return summary;
}
