/**
 * discord ソースのオーケストレータ(ADR-0033)。
 * targets ゲート → open PR ガード → KB sync → state/索引/domain 読み → 収集セッション
 * (fetch → filter → window → close)→ 著者正規化 → extract → guards → resolvePeople →
 * reconcile(並列)→ materialize(直列)→ staging → validateRepo → PR → 通知 →
 * state を main へ直 commit(CONFLICT 1 回再試行)。
 * 全副作用は注入 seam。カーソル規約: filter で落とした分は前進 / 予算切れ・抽出失敗の
 * ウィンドウは前進させない(次回再訪)。
 */
import { join } from "node:path";
import type { ChannelsConfig } from "@stratum/discord-bot/config";
import { isChannelAllowed } from "@stratum/discord-bot/config";
import { type FileChange, type GhClient, GhClientError } from "@stratum/gh-client";
import {
  githubForDiscord,
  type IdKind,
  type Members,
  nameForDiscord,
  parseMembers,
  type Source,
  urlToSource,
} from "@stratum/kb-core";
import type { SyncedKb } from "@stratum/shared";
import { mapWithLimit } from "../concurrency.js";
import { listDomains, type ReaddirFn } from "../domains.js";
import type { ExtractDeps } from "../extract.js";
import { applyCandidateGuards } from "../guards.js";
import type { Logger } from "../logger.js";
import { isValidPerson, type MaterializeDeps, materializeOne } from "../materialize.js";
import type { Notifier, NotifyCounts } from "../notify.js";
import { buildNameResolver, resolvePeople } from "../participants.js";
import { type ReconcileDeps, reconcileCandidate } from "../reconcile.js";
import { pickReviewer } from "../review.js";
import { type DiscordSourceConfig, rotateChannels } from "./config.js";
import { extractFromWindow } from "./extract.js";
import { buildPermalinkIndex, type PrefilterDeps } from "./prefilter.js";
import {
  DISCORD_STATE_PATH,
  type DiscordState,
  readDiscordState,
  serializeDiscordState,
  snowflakeForDate,
} from "./state.js";
import { filterMessages, groupIntoWindows, type WindowMessage } from "./window.js";

export const DISCORD_BRANCH_PREFIX = "extract-discord/";

/** collector セッションの構造的最小形(@stratum/discord-bot/collector と互換・テストは fake)。 */
export interface CollectorSessionLike {
  listReadableTextChannels(): { id: string; name: string; parentId: string | null }[];
  fetchMessagesAfter(
    channelId: string,
    afterId: string | null,
    cap: number,
  ): Promise<WindowMessage[]>;
  close(): Promise<void>;
}

export interface DiscordRunDeps {
  config: DiscordSourceConfig;
  /** bot と共有するチャンネルゲート(permanent_exclude・ADR-0018)。 */
  channelsConfig: ChannelsConfig;
  openSession(): Promise<CollectorSessionLike>;
  syncKb(): Promise<SyncedKb>;
  gh: GhClient;
  extractDeps: ExtractDeps;
  reconcileDeps: ReconcileDeps;
  makeId: (kind: IdKind, now?: Date) => string;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** knowledge/<domain>/ 列挙(domain 再利用・⑱)。 */
  readdir: ReaddirFn;
  /** permalink 索引の走査(再帰・不在は [])。 */
  listFiles: PrefilterDeps["listFiles"];
  notifier: Notifier;
  now: () => Date;
  logger: Logger;
  /** true で実 PR + state commit。false は dry-run(ログのみ)。 */
  real: boolean;
  reconcileConcurrency: number;
}

export interface DiscordRunSummary {
  created: boolean;
  reason?:
    | "disabled"
    | "already-exists"
    | "no-messages"
    | "no-entries"
    | "validation-failed"
    | "dry-run"
    | "created";
  prUrl?: string;
  counts: NotifyCounts;
  channelsProcessed: number;
  messagesFetched: number;
  windowsExtracted: number;
  /** 予算切れ・抽出失敗で今回処理しなかったウィンドウ数(カーソル非前進 = 次回再訪)。 */
  windowsDeferred: number;
  stateCommitted: boolean;
}

const NOTIFY_LABEL = "Discord 抽出";

function emptyCounts(): NotifyCounts {
  return { new: 0, append: 0, supersede: 0, skip: 0, openQuestions: 0 };
}

function jstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function jstHm(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(11, 16).replace(":", "");
}

/** members.yaml から著者正規化を作る(ADR-0033 D8)。読めなければ表示名のまま。 */
async function loadAuthorNormalizer(
  kbRoot: string,
  readFile: DiscordRunDeps["readFile"],
  logger: Logger,
): Promise<{
  normalize: (m: WindowMessage) => WindowMessage;
  resolveName?: (raw: string) => string | null;
}> {
  try {
    const members: Members = parseMembers(await readFile(join(kbRoot, "_meta", "members.yaml")));
    const resolveName = buildNameResolver(members.members);
    return {
      resolveName,
      normalize: (m) => ({
        ...m,
        authorName:
          githubForDiscord(members, m.authorId) ??
          nameForDiscord(members, m.authorId) ??
          resolveName(m.authorName) ??
          m.authorName,
      }),
    };
  } catch (e) {
    logger.warn("members.yaml を読めないため著者名の正規化なしで続行します", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { normalize: (m) => m };
  }
}

/** state の main 直 commit(D3)。non-FF CONFLICT は 1 回だけ再試行(commitFiles は毎回 ref を取り直す)。 */
async function commitStateWithRetry(
  deps: DiscordRunDeps,
  content: string,
  message: string,
): Promise<boolean> {
  const files: FileChange[] = [{ path: DISCORD_STATE_PATH, content }];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.gh.commitFiles({
        repo: deps.config.kb.repo,
        branch: deps.config.base_branch,
        message,
        files,
      });
      return true;
    } catch (e) {
      if (e instanceof GhClientError && e.code === "CONFLICT" && attempt === 0) {
        deps.logger.warn("state commit が non-FF(他バッチと競合)。1 回だけ再試行します。");
        continue;
      }
      deps.logger.warn("state commit に失敗(次回 run が同区間を再訪します)", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }
  return false;
}

export async function runDiscordSource(deps: DiscordRunDeps): Promise<DiscordRunSummary> {
  const { config, logger } = deps;
  const now = deps.now();
  const counts = emptyCounts();
  const base: Omit<DiscordRunSummary, "created" | "reason"> = {
    counts,
    channelsProcessed: 0,
    messagesFetched: 0,
    windowsExtracted: 0,
    windowsDeferred: 0,
    stateCommitted: false,
  };

  if (!config.all_visible && config.targets.length === 0) {
    logger.info("discord ソースは無効です(targets が空・all_visible も false・ADR-0033 D9)。");
    return { created: false, reason: "disabled", ...base };
  }

  const reviewer = pickReviewer(config.review_mentions, now);

  // 冪等ガード(D7): open な extract-discord/* PR がある間は新規提案もカーソル前進もしない
  // (未マージ PR のエントリは permalink 索引(③)に載らず、すり抜けるため)。
  if (deps.real) {
    const open = (await deps.gh.listPullRequests(config.kb.repo, { state: "open" })).find((p) =>
      p.headRef.startsWith(DISCORD_BRANCH_PREFIX),
    );
    if (open) {
      logger.info("未マージの Discord 抽出 PR があるため skip(冪等)", { prUrl: open.url });
      await deps.notifier.notifySkipped({
        prUrl: open.url,
        label: NOTIFY_LABEL,
        ...(reviewer !== undefined ? { reviewer } : {}),
      });
      return { created: false, reason: "already-exists", prUrl: open.url, ...base };
    }
  }

  const kb = await deps.syncKb();
  const kbRoot = kb.absDir;
  const stateRaw = await deps.readFile(join(kbRoot, DISCORD_STATE_PATH)).catch(() => null);
  const state = readDiscordState(stateRaw, logger);
  const knownUrls = await buildPermalinkIndex(kbRoot, {
    listFiles: deps.listFiles,
    readFile: deps.readFile,
  });
  const domainSet = new Set(await listDomains(kbRoot, deps.readdir));
  const { normalize, resolveName } = await loadAuthorNormalizer(kbRoot, deps.readFile, logger);
  const backfillAfter = snowflakeForDate(
    new Date(now.getTime() - config.backfill_days * 86_400_000),
  );

  // 収集(fetch → filter → window)。セッションは LLM の前に必ず閉じる(短命・D5)。
  const session = await deps.openSession();
  const channelWindows: { channelId: string; windows: WindowMessage[][]; lastFetchedId: string }[] =
    [];
  const nextChannels: DiscordState["channels"] = { ...(state?.channels ?? {}) };
  try {
    const readable = new Map(session.listReadableTextChannels().map((c) => [c.id, c]));
    // 対象の母集団: all_visible なら可視テキストチャンネル全部(ID 昇順 = ローテーションが決定的)、
    // でなければ targets の明示リスト。どちらも exclude(本ソース専用)と permanent_exclude(bot 全体)で絞る。
    const excluded = new Set(config.exclude);
    const universe = config.all_visible ? [...readable.keys()].sort() : config.targets;
    const eligible = rotateChannels(universe, now).filter((id) => {
      const ch = readable.get(id);
      if (ch === undefined) return false; // bot 不可視 or 不存在
      if (excluded.has(id)) return false;
      return isChannelAllowed(deps.channelsConfig, {
        channelId: id,
        parentId: ch.parentId,
        botCanView: true,
      });
    });
    logger.info("対象チャンネル", {
      mode: config.all_visible ? "all_visible" : "targets",
      readable: readable.size,
      eligible: eligible.length,
      maxChannels: config.max_channels,
    });
    for (const channelId of eligible) {
      if (base.channelsProcessed >= config.max_channels) break;
      base.channelsProcessed += 1;
      const afterId = state?.channels[channelId]?.last_message_id ?? backfillAfter;
      const fetched = await session.fetchMessagesAfter(
        channelId,
        afterId,
        config.max_messages_per_channel,
      );
      if (fetched.length === 0) continue;
      base.messagesFetched += fetched.length;
      const { kept, dropped } = filterMessages(fetched, knownUrls);
      logger.info("チャンネル収集", {
        channelId,
        fetched: fetched.length,
        kept: kept.length,
        dropped,
      });
      const windows = groupIntoWindows(kept.map(normalize), {
        gapMinutes: config.window_gap_minutes,
        maxMessages: config.window_max_messages,
      });
      const lastFetched = fetched[fetched.length - 1];
      if (lastFetched === undefined) continue;
      channelWindows.push({ channelId, windows, lastFetchedId: lastFetched.id });
    }
  } finally {
    await session.close();
  }

  if (channelWindows.length === 0) {
    logger.info("新規メッセージはありません。", { channels: base.channelsProcessed });
    return { created: false, reason: "no-messages", ...base };
  }

  // 抽出 → ガード → 正規化 → 突合 → materialize(予算 = max_extract_calls・D7)。
  const materializeDeps: MaterializeDeps = { makeId: deps.makeId, now: deps.now };
  const files: FileChange[] = [];
  const people = new Set<string>();
  const listing: { title: string; domain?: string; action: string }[] = [];
  let budget = config.max_extract_calls;
  for (const cw of channelWindows) {
    let processedThroughId: string | null = null;
    let processedInChannel = 0;
    let allProcessed = true;
    for (const window of cw.windows) {
      if (budget <= 0) {
        allProcessed = false;
        break;
      }
      const first = window[0];
      const last = window[window.length - 1];
      if (first === undefined || last === undefined) continue;
      budget -= 1;
      let extraction: Awaited<ReturnType<typeof extractFromWindow>>["value"];
      try {
        const r = await extractFromWindow(
          { window, cwd: kbRoot },
          { ...deps.extractDeps, existingDomains: [...domainSet] },
        );
        extraction = r.value;
      } catch (e) {
        // 失敗ウィンドウはカーソルを進めない(次回再訪)。このチャンネルの以降も止める(順序保持)。
        logger.warn("ウィンドウ抽出に失敗(次回再訪)", {
          channelId: cw.channelId,
          error: e instanceof Error ? e.message : String(e),
        });
        allProcessed = false;
        break;
      }
      base.windowsExtracted += 1;
      const guarded = applyCandidateGuards(extraction);
      extraction = guarded.extraction;
      if (resolveName !== undefined) {
        extraction = {
          ...extraction,
          decisions: extraction.decisions.map((d) => ({
            ...d,
            deciders: resolvePeople(d.deciders, resolveName),
          })),
          learnings: extraction.learnings.map((l) => ({
            ...l,
            people: resolvePeople(l.people, resolveName),
          })),
        };
      }
      counts.openQuestions += extraction.openQuestions.length; // v1: 件数のみ(起票しない・D9)
      const source: Source = urlToSource(first.url);
      const candidates = [...extraction.decisions, ...extraction.learnings];
      const verdicts = await mapWithLimit(candidates, deps.reconcileConcurrency, async (c) => {
        try {
          return {
            ok: true as const,
            verdict: (await reconcileCandidate(c, kbRoot, deps.reconcileDeps)).value,
          };
        } catch (e) {
          return { ok: false as const, error: e };
        }
      });
      for (let i = 0; i < candidates.length; i += 1) {
        const c = candidates[i];
        const v = verdicts[i];
        if (c === undefined || v === undefined) continue;
        if (!v.ok) {
          counts.skip += 1;
          logger.warn("reconcile 失敗のため候補を skip", {
            title: c.title,
            error: v.error instanceof Error ? v.error.message : String(v.error),
          });
          continue;
        }
        const change = await materializeOne(
          {
            kbRoot,
            source,
            fallbackPeople: [],
            candidate: c,
            verdict: v.verdict,
            sourceDate: first.createdAt,
          },
          materializeDeps,
        );
        if (change.action === "new") counts.new += 1;
        else if (change.action === "append") counts.append += 1;
        else if (change.action === "supersede") counts.supersede += 1;
        else counts.skip += 1;
        files.push(...change.files);
        if (change.action !== "skip") {
          listing.push({
            title: c.title,
            ...(c.kind === "learning" ? { domain: c.domain } : {}),
            action: change.action,
          });
          if (c.kind === "learning" && change.action === "new") domainSet.add(c.domain);
        }
        const names = c.kind === "decision" ? c.deciders : c.people;
        for (const n of names) if (isValidPerson(n)) people.add(n);
      }
      processedThroughId = last.id;
      processedInChannel += 1;
    }
    base.windowsDeferred += cw.windows.length - processedInChannel;
    // カーソル前進(D3 規約): 全ウィンドウ処理済みなら取得末尾まで(末尾の filter 落ち分も含む)。
    // 途中まで(予算切れ・失敗)なら最後に処理したウィンドウの末尾まで。未処理なら不動。
    const advanceTo = allProcessed ? cw.lastFetchedId : processedThroughId;
    if (advanceTo !== null) {
      nextChannels[cw.channelId] = {
        last_message_id: advanceTo,
        last_processed_at: now.toISOString(),
      };
    }
  }

  // PR 作成(entries > 0 のとき・state は同梱しない)。
  let created = false;
  let prUrl: string | undefined;
  let reason: DiscordRunSummary["reason"];
  if (files.length > 0) {
    for (const f of files) {
      await deps.writeFile(join(kbRoot, f.path), f.content);
    }
    const report = await deps.validate(kbRoot);
    if (!report.ok) {
      logger.error("validateRepo が赤のため PR を作りません(ADR-0004 D2)。", {
        problems: report.problems.length,
      });
      reason = "validation-failed";
    } else if (!deps.real) {
      logger.info("dry-run: PR を作りません。", {
        entries: listing.length,
        files: files.map((f) => f.path),
      });
      reason = "dry-run";
    } else {
      const branch = `${DISCORD_BRANCH_PREFIX}${jstDate(now)}-${jstHm(now)}`;
      const body = [
        "Discord チャンネル会話からの自動抽出(extractor discord ソース・ADR-0033)。内容を確認し、問題なければ 👍、修正は PR で直接編集してください。",
        `- 新規: ${counts.new} / 出典追記: ${counts.append} / 矛盾更新: ${counts.supersede} / skip: ${counts.skip}`,
        `- 未解決の問い(v1 は起票せず件数のみ): ${counts.openQuestions}`,
        "",
        "### 収録エントリ",
        ...listing.map(
          (e) => `- ${e.title}(${e.domain ?? "決定"}${e.action === "new" ? "" : `・${e.action}`})`,
        ),
        people.size > 0 ? `\n関係者: ${[...people].join(", ")}` : "",
      ]
        .filter((l) => l.length > 0)
        .join("\n");
      const pr = await deps.gh.createPullRequest({
        repo: config.kb.repo,
        head: branch,
        base: config.base_branch,
        title: `extract-discord: ${jstDate(now)} Discord 会話からのナレッジ抽出(${listing.length} 件)`,
        body,
        files,
      });
      created = true;
      prUrl = pr.url;
      reason = "created";
      await deps.notifier.notifyPrCreated({
        prUrl: pr.url,
        label: NOTIFY_LABEL,
        counts,
        people: [...people],
        ...(reviewer !== undefined ? { reviewer } : {}),
      });
    }
  } else {
    reason = "no-entries";
    logger.info("materialize 対象がありません(全ウィンドウ空振り)。", {
      windows: base.windowsExtracted,
    });
  }

  // state の main 直 commit(D3)。PR の成否と独立(dry-run 中の validation-failed は前進させない)。
  const nextState: DiscordState = {
    version: 1,
    channels: nextChannels,
    last_run_at: now.toISOString(),
  };
  const nextRaw = serializeDiscordState(nextState);
  const cursorMoved =
    serializeDiscordState({
      version: 1,
      channels: state?.channels ?? {},
      last_run_at: now.toISOString(),
    }) !== nextRaw;
  if (cursorMoved && reason !== "validation-failed") {
    if (deps.real) {
      base.stateCommitted = await commitStateWithRetry(
        deps,
        nextRaw,
        `chore(extractor-discord): カーソル前進(${jstDate(now)})`,
      );
    } else {
      logger.info("dry-run: state commit をスキップします(カーソルは前進予定)", {
        channels: Object.keys(nextChannels).length,
      });
    }
  }

  return { created, reason, ...(prUrl !== undefined ? { prUrl } : {}), ...base };
}
