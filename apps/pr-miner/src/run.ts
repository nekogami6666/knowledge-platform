/**
 * pr-miner オーケストレータ(design.md §6.4 ③-c)。
 * 対象リポごとに「直近マージ済み PR」を列挙 → 各 PR を extract → reconcile → materialize →
 * KB clone に staging → validateRepo → 週次 1 PR → 通知。全副作用は注入 seam(gh/LLM/fs/validate/id/clock)。
 * 実 PR は realPr フラグ時のみ(既定 dry-run)。カーソルは PR に含めて前進(merge 時に main 反映・extractor と同方式)。
 *
 * 冪等: open な `pr-miner/*` PR が既にあれば新規提案を保留する(週キーだけでは、先週の PR が未マージのまま
 * 翌週実行 → 同じ PR 群を再マイニング + id-counter 競合、を防げないため)。
 */
import { join } from "node:path";
import { mapWithLimit } from "@stratum/extractor/concurrency";
import { checkDomainProximity, listDomains, type ReaddirFn } from "@stratum/extractor/domains";
import {
  type MaterializeAction,
  type MaterializeDeps,
  materializeOne,
} from "@stratum/extractor/materialize";
import { type ReconcileDeps, reconcileCandidate } from "@stratum/extractor/reconcile";
import type { GhClient, MergedPrSummary } from "@stratum/gh-client";
import type { IdCounterStore, Source } from "@stratum/kb-core";
import type { PrMinerConfig } from "./config.js";
import { type PrMinerState, readState, serializeState } from "./cursor.js";
import { extractFromPr, type PrExtractDeps, type PrInput } from "./extract.js";
import type { Logger } from "./logger.js";
import type { Notifier, NotifyCounts } from "./notify.js";
import { isoWeekKey } from "./week.js";

export interface RunDeps {
  config: PrMinerConfig;
  /** KB clone のルート(workflow の checkout 済み)。 */
  kbRoot: string;
  /** KB への書き込み(提案 PR 作成・open 検知)用クライアント(GitHub App)。 */
  gh: GhClient;
  /**
   * 対象リポの読み取り専用クライアント(ADR-0013 D4 の hybrid: read = PAT / write = App)。
   * App のインストール先を対象リポへ広げないための分離。未指定なら gh を使う(単一認証でも動く)。
   */
  ghRead?: GhClient;
  extractDeps: Omit<PrExtractDeps, "existingDomains" | "cwd">;
  reconcileDeps: ReconcileDeps;
  makeIdStore: (kbRoot: string) => IdCounterStore;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  readdir: ReaddirFn;
  notifier: Notifier;
  now: () => Date;
  logger: Logger;
  realPr: boolean;
  reconcileConcurrency: number;
}

export interface PrMinerSummary {
  created: boolean;
  reason?: string;
  prUrl?: string;
  counts: NotifyCounts;
  minedPrs: number;
  /** cap(max_prs)到達により今回処理せず次回へ持ち越した PR 数(ADR-0023 D4 の可視化)。 */
  deferredPrs: number;
  fileCount: number;
}

const EMPTY_COUNTS = (): NotifyCounts => ({
  new: 0,
  append: 0,
  supersede: 0,
  skip: 0,
  openQuestions: 0,
});

function bump(counts: NotifyCounts, action: MaterializeAction): void {
  if (action === "new") counts.new += 1;
  else if (action === "append") counts.append += 1;
  else if (action === "supersede") counts.supersede += 1;
  else counts.skip += 1;
}

/** since(ISO)を決める。カーソルがあればその時刻、無ければ now − window_days。 */
function sinceFor(state: PrMinerState | null, repo: string, now: Date, windowDays: number): string {
  const cursor = state?.repos[repo]?.last_merged_at;
  if (cursor !== undefined) return cursor;
  return new Date(now.getTime() - windowDays * 86_400_000).toISOString();
}

/**
 * cap(max_prs)指定時のみ、開始リポを日替わりでローテートした配列を返す(公平性)。
 * config 順のままだと後方のリポが毎回予算切れで永久に処理されない(飢餓)。日次ローテートで
 * targets.length 日かけて全リポが先頭側に回る(gap-tracker のラウンドロビンと同方式)。
 * uncapped(max_prs 未指定)や単一リポでは config 順のまま=現挙動を変えない。
 */
export function rotateTargets(
  targets: readonly string[],
  maxPrs: number | undefined,
  now: Date,
): string[] {
  if (maxPrs === undefined || targets.length <= 1) return [...targets];
  const start = Math.floor(now.getTime() / 86_400_000) % targets.length;
  return [...targets.slice(start), ...targets.slice(0, start)];
}

export async function runPrMiner(deps: RunDeps): Promise<PrMinerSummary> {
  const { config, logger } = deps;
  const counts = EMPTY_COUNTS();

  if (config.targets.length === 0) {
    logger.info("targets が空です。マイニングをスキップします(§14#5 未決・機能 OFF)。");
    return {
      created: false,
      reason: "disabled",
      counts,
      minedPrs: 0,
      deferredPrs: 0,
      fileCount: 0,
    };
  }

  const statePath = join(deps.kbRoot, "_meta", "pr-miner-state.json");
  const state = await readState(statePath, deps.readFile);

  // 冪等ガード(実 PR 時のみ)。open な pr-miner/* PR がある間は新規提案を出さない。
  if (deps.realPr) {
    const open = await deps.gh.listPullRequests(config.kb.repo, { state: "open" });
    const existing = open.find((p) => p.headRef.startsWith("pr-miner/"));
    if (existing !== undefined) {
      logger.info("未マージの pr-miner PR があるため今回はスキップします。", { pr: existing.url });
      return {
        created: false,
        reason: "already-exists",
        counts,
        minedPrs: 0,
        deferredPrs: 0,
        fileCount: 0,
      };
    }
  }

  const existingDomains = await listDomains(deps.kbRoot, deps.readdir);
  const idStore = deps.makeIdStore(deps.kbRoot);
  const materializeDeps: MaterializeDeps = { idStore, now: deps.now, readFile: deps.readFile };
  const extractDeps: PrExtractDeps = { ...deps.extractDeps, existingDomains, cwd: deps.kbRoot };

  const files: { path: string; content: string }[] = [];
  const newRepoCursors: PrMinerState["repos"] = { ...(state?.repos ?? {}) };
  const now = deps.now();
  // 1 run の PR 上限(全リポ合計・ADR-0023 D3 の pr-miner 版)。未指定 = 無制限(現挙動)。
  const cap = config.max_prs ?? Number.POSITIVE_INFINITY;
  const targets = rotateTargets(config.targets, config.max_prs, now);
  let minedPrs = 0;
  let deferredPrs = 0;

  for (const repo of targets) {
    if (minedPrs >= cap) {
      // 予算切れ。残りのリポは今回スキャンしない(カーソル据え置き=次回ローテートで先頭側に回り優先)。
      break;
    }
    try {
      const since = sinceFor(state, repo, now, config.window_days);
      const cursor = state?.repos[repo]?.last_merged_at ?? null;
      const merged = await (deps.ghRead ?? deps.gh).listMergedPullRequests(repo, { since });
      // カーソル由来の since は境界の再処理を避けるため merged_at > cursor で絞る(初回=cursor null は全件)。
      const fresh = (cursor === null ? merged : merged.filter((p) => p.mergedAt > cursor)).sort(
        (a, b) => a.mergedAt.localeCompare(b.mergedAt), // 昇順 = カーソルが最大に前進
      );
      if (fresh.length === 0) {
        logger.info("新しいマージ PR はありません。", { repo });
        continue;
      }
      logger.info("PR を取得しました。", { repo, count: fresh.length });

      let processedMerged: string | undefined;
      let processedInRepo = 0;
      for (const pr of fresh) {
        // 予算超過後は打ち切るが、直前の PR と同一 merged_at の PR だけは巻き込む。カーソルは
        // 単一 timestamp なので、同時刻の PR 群を境界で分割するとカーソル前進で未処理側が > cursor
        // から漏れて静かに欠落する。timestamp 単位で不可分に処理して欠落を防ぐ(超過は最大でも同時刻分)。
        if (minedPrs >= cap && pr.mergedAt !== processedMerged) break;
        await minePr(
          repo,
          pr,
          { ...deps, extractDeps, materializeDeps, existingDomains },
          counts,
          files,
        );
        minedPrs += 1;
        processedInRepo += 1;
        processedMerged = pr.mergedAt;
      }
      deferredPrs += fresh.length - processedInRepo;
      // カーソルは「処理した最後の PR」まで前進(未処理は次回 > cursor で再取得=持ち越し安全)。
      // 全件処理なら processedMerged === fresh[last].mergedAt で現挙動と一致する。
      if (processedMerged !== undefined) {
        newRepoCursors[repo] = { last_merged_at: processedMerged };
      }
    } catch (e) {
      // リポ単位で失敗を隔離(1 リポの API 失敗で全体を落とさない)。
      logger.error("リポの処理に失敗。スキップして続行します。", {
        repo,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (deferredPrs > 0) {
    logger.info("cap 到達により PR を次回 run へ持ち越します(ADR-0023 と同型)。", {
      cap: config.max_prs,
      minedPrs,
      deferredPrs,
    });
  }

  if (files.length === 0) {
    logger.info("materialize 対象がありません。PR を作成しません。", { minedPrs });
    return { created: false, reason: "no-entries", counts, minedPrs, deferredPrs, fileCount: 0 };
  }

  // clone に staging(validateRepo がディスクを読む)+ カーソル/採番ファイルを PR に含める。
  for (const f of files) {
    await deps.writeFile(join(deps.kbRoot, f.path), f.content);
  }
  const newState: PrMinerState = { repos: newRepoCursors, last_run_at: now.toISOString() };
  await deps.writeFile(statePath, serializeState(newState));
  files.push({ path: "_meta/pr-miner-state.json", content: serializeState(newState) });
  const counter = await deps
    .readFile(join(deps.kbRoot, "_meta", "id-counter.json"))
    .catch(() => null);
  if (counter !== null) files.push({ path: "_meta/id-counter.json", content: counter });

  const report = await deps.validate(deps.kbRoot);
  if (!report.ok) {
    logger.error("validateRepo が失敗。PR を作成しません(§6.1 / ADR-0004 D2)。", {
      problems: report.problems.length,
    });
    return {
      created: false,
      reason: "validation-failed",
      counts,
      minedPrs,
      deferredPrs,
      fileCount: files.length,
    };
  }

  const head = `pr-miner/${isoWeekKey(now)}`;
  const title = `docs(kb): 週次 PR マイニング(${isoWeekKey(now)}・${config.targets.length} リポ / ${minedPrs} PR)`;
  if (!deps.realPr) {
    logger.info("dry-run: 実 PR は作成しません(PR_MINER_REAL 未設定)。", {
      files: files.length,
      title,
    });
    return {
      created: false,
      reason: "dry-run",
      counts,
      minedPrs,
      deferredPrs,
      fileCount: files.length,
    };
  }

  const pr = await deps.gh.createPullRequest({
    repo: config.kb.repo,
    head,
    base: config.base_branch,
    title,
    body: buildPrBody(counts, minedPrs, deferredPrs, config.targets),
    files,
  });
  await deps.notifier.notifyPrCreated({
    prUrl: pr.url,
    minedPrs,
    repos: config.targets.length,
    counts,
  });
  logger.info("PR マイニングの提案 PR を作成しました。", { prUrl: pr.url, files: files.length });
  return { created: true, prUrl: pr.url, counts, minedPrs, deferredPrs, fileCount: files.length };
}

/** 1 PR を extract → reconcile → materialize し、counts と files に反映する。 */
async function minePr(
  repo: string,
  pr: MergedPrSummary,
  deps: RunDeps & {
    extractDeps: PrExtractDeps;
    materializeDeps: MaterializeDeps;
    existingDomains: readonly string[];
  },
  counts: NotifyCounts,
  files: { path: string; content: string }[],
): Promise<void> {
  const [comments, prFiles] = await Promise.all([
    (deps.ghRead ?? deps.gh).listPullRequestComments(repo, pr.number),
    (deps.ghRead ?? deps.gh).listPullRequestFiles(repo, pr.number),
  ]);
  const input: PrInput = {
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    comments,
    files: prFiles,
  };
  const { value: extraction } = await extractFromPr(input, deps.extractDeps);
  counts.openQuestions += extraction.openQuestions.length; // open_questions は materialize せず件数のみ(D7)
  const candidates = [...extraction.decisions, ...extraction.learnings];
  if (candidates.length === 0) return;

  const source: Source = { kind: "pr", repo, number: pr.number };
  const fallbackPeople = pr.author !== null ? [pr.author] : [];

  // reconcile は read-only なので並列化、materialize(採番)は逐次(extractor と同方針)。
  const verdicts = await mapWithLimit(candidates, deps.reconcileConcurrency, async (c) => {
    try {
      const { value } = await reconcileCandidate(c, deps.kbRoot, deps.reconcileDeps);
      return { ok: true as const, verdict: value };
    } catch (e) {
      return { ok: false as const, error: e };
    }
  });

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const r = verdicts[i];
    if (c === undefined || r === undefined) continue;
    if (!r.ok) {
      counts.skip += 1;
      deps.logger.warn("reconcile 失敗のため候補を skip", {
        repo,
        pr: pr.number,
        error: r.error instanceof Error ? r.error.message : String(r.error),
      });
      continue;
    }
    const change = await materializeOne(
      { kbRoot: deps.kbRoot, source, fallbackPeople, candidate: c, verdict: r.verdict },
      deps.materializeDeps,
    );
    bump(counts, change.action);
    files.push(...change.files);
    if (c.kind === "learning" && change.action === "new") {
      const near = checkDomainProximity(c.domain, deps.existingDomains);
      if (near !== null) {
        deps.logger.warn("新設 domain が既存に近い(集約候補)", { domain: c.domain, near });
      }
    }
  }
}

function buildPrBody(
  counts: NotifyCounts,
  minedPrs: number,
  deferredPrs: number,
  targets: readonly string[],
): string {
  const lines = [
    "直近のマージ済み PR から、設計判断・ハマりどころを抽出しました(§6.4 ③-c)。",
    "コード/diff は知識化していません(判断と理由のみ)。",
    "",
    `- 対象リポ: ${targets.join(", ")}`,
    `- マイニングした PR 数: ${minedPrs}`,
    `- 新規 ${counts.new} / 追記 ${counts.append} / 矛盾 ${counts.supersede} / skip ${counts.skip}`,
  ];
  if (deferredPrs > 0) {
    // ADR-0023 D4: cap 到達の持ち越しを本文にも出す(カーソル前進で静かに消えないように)。
    lines.push(`- 持ち越し: 1 run 上限に達したため ${deferredPrs} 件は次回 run で処理します`);
  }
  lines.push("", "スキーマ検証はこのリポの validate CI が行います。問題なければ 👍 で代理マージ。");
  return lines.join("\n");
}
