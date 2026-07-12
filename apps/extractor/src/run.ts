/**
 * extractor オーケストレータ(design.md §6.3)。sync → cursor → diff → 各議事録を
 * extract → reconcile → materialize → clone に staging → validateRepo → 1日1PR → 通知。
 * 全副作用は注入 seam(syncer/gh/LLM/git/fs/validate/id/clock)。ユニットは fake のみ。
 * 実 PR は realPr フラグ時のみ(既定 dry-run)。カーソルは PR に含めて前進(merge 時に main 反映)。
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { FileChange, GhClient } from "@stratum/gh-client";
import type { IdCounterStore, Source } from "@stratum/kb-core";
import type { DecisionCandidate, LearningCandidate } from "./candidate.js";
import { mapWithLimit } from "./concurrency.js";
import type { ExtractorConfig } from "./config.js";
import { type ExtractorState, readState, serializeState } from "./cursor.js";
import { changedMinutesFiles, type GitExec } from "./diff.js";
import { checkDomainProximity, listDomains, type ReaddirFn } from "./domains.js";
import { type ExtractDeps, extractFromMinutes } from "./extract.js";
import type { Logger } from "./logger.js";
import { type MaterializeAction, type MaterializeDeps, materializeOne } from "./materialize.js";
import type { Notifier, NotifyCounts } from "./notify.js";
import { buildPrTitle, findExistingPr, shortSha } from "./pr-title.js";
import { type ReconcileDeps, reconcileCandidate } from "./reconcile.js";
import type { RepoSyncer } from "./repos.js";

export interface RunDeps {
  config: ExtractorConfig;
  syncer: RepoSyncer;
  gh: GhClient;
  extractDeps: ExtractDeps;
  reconcileDeps: ReconcileDeps;
  /** kbRoot から採番ストアを作る(実: createLocalIdCounterStore、テスト: in-memory)。 */
  makeIdStore: (kbRoot: string) => IdCounterStore;
  /** KB clone のスキーマ検証(実: validateRepo)。 */
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  exec: GitExec;
  /** knowledge/<domain>/ 列挙(実: fs.readdir(..,{withFileTypes:true}))。domain 再利用に使う。 */
  readdir: ReaddirFn;
  notifier: Notifier;
  now: () => Date;
  logger: Logger;
  /** true で実 PR 作成、false で dry-run(既定)。 */
  realPr: boolean;
  /** reconcile の並列上限(⑱・§2-E。index.ts の EXTRACTOR_RECONCILE_CONCURRENCY・既定 4)。 */
  reconcileConcurrency: number;
  /** 単調増加ミリ秒(段階別所要時間の計測。既定 performance.now。テストで注入)。 */
  monotonicMs?: () => number;
}

/** domain 乱立の数値化(⑱・§1-B)。主観でなく数値で改善判定するための run メトリクス。 */
export interface DomainMetrics {
  /** materialize 対象候補数(decisions + learnings)。 */
  candidateCount: number;
  /** 今回新設した domain(run 開始時に存在しなかった learning domain)。 */
  newDomains: string[];
  /** 既存 domain に載った新規 learning の件数(再利用)。 */
  reusedDomainCount: number;
  /** 新設 domain が既存に近い(集約候補)警告。人間が PR で folder rename して集約する。 */
  nearDuplicates: { domain: string; near: string }[];
}

/** 段階別所要時間(⑱・§2-D。300s でも密度次第で落ちうるため、次の判断材料として記録する)。 */
export interface StageTimings {
  extractMs: number;
  reconcileMs: number;
  materializeMs: number;
}

export interface RunSummary {
  created: boolean;
  reason?: string;
  prUrl?: string;
  counts: NotifyCounts;
  domains: DomainMetrics;
  timings?: StageTimings;
  fileCount: number;
}

function emptyCounts(): NotifyCounts {
  return { new: 0, append: 0, supersede: 0, skip: 0, openQuestions: 0 };
}

function emptyDomains(): DomainMetrics {
  return { candidateCount: 0, newDomains: [], reusedDomainCount: 0, nearDuplicates: [] };
}

/**
 * 新規 learning の domain を集計する(§1-B/§2-C)。既存に無ければ新設として記録し、
 * 既存名と近接(hardware-verification ⊃ hardware 等)なら警告に積む。domainSet を更新して
 * 同一 run 内の後続 extract に反映する(乱立の自家撞着を防ぐ)。
 */
function recordLearningDomain(
  domain: string,
  domainSet: Set<string>,
  metrics: DomainMetrics,
  logger: Logger,
): void {
  if (domainSet.has(domain)) {
    metrics.reusedDomainCount += 1;
    return;
  }
  const near = checkDomainProximity(domain, [...domainSet]);
  if (near !== null) {
    metrics.nearDuplicates.push({ domain, near });
    logger.warn("新設 domain が既存に近い(PR で集約を検討)", { domain, near });
  }
  metrics.newDomains.push(domain);
  domainSet.add(domain);
}

function bump(counts: NotifyCounts, action: MaterializeAction): void {
  if (action === "new") counts.new += 1;
  else if (action === "append") counts.append += 1;
  else if (action === "supersede") counts.supersede += 1;
  else counts.skip += 1;
}

function addPeople(people: Set<string>, c: DecisionCandidate | LearningCandidate): void {
  const names = c.kind === "decision" ? c.deciders : c.people;
  for (const n of names) people.add(n);
}

/** ログ用の短い候補ラベル(skip 記録時に何が落ちたか分かるように)。 */
function candidateLabel(c: DecisionCandidate | LearningCandidate): string {
  return `${c.kind}:${c.title}`;
}

/** 議事録の「参加者: a, b」行から参加者を抽出(owner/deciders フォールバック)。 */
export function parseParticipants(content: string): string[] {
  const m = /(?:参加者|participants?)\s*[:：]\s*(.+)/i.exec(content);
  if (m?.[1] === undefined) return [];
  return m[1]
    .split(/[,、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildPrBody(
  counts: NotifyCounts,
  domains: DomainMetrics,
  people: readonly string[],
): string {
  const newDomains = domains.newDomains.length > 0 ? domains.newDomains.join(", ") : "なし";
  return [
    "議事録からの自動抽出(extractor)。内容を確認し、問題なければ 👍、修正は PR で直接編集してください。",
    `- 新規: ${counts.new}`,
    `- 出典追記: ${counts.append}`,
    `- 矛盾更新: ${counts.supersede}`,
    `- skip: ${counts.skip}`,
    `- 未解決の問い(未 materialize): ${counts.openQuestions}`,
    `- 新設 domain: ${newDomains}(既存再利用 ${domains.reusedDomainCount} 件)`,
    domains.nearDuplicates.length > 0
      ? `- ⚠️ 近接 domain(集約候補): ${domains.nearDuplicates
          .map((n) => `${n.domain}≈${n.near}`)
          .join(", ")}`
      : "",
    people.length > 0 ? `関係者: ${people.join(", ")}` : "",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

export async function runExtractor(deps: RunDeps): Promise<RunSummary> {
  const { config, logger } = deps;
  const synced = await deps.syncer.sync();
  const kbRoot = synced.kb.absDir;
  const minutesRoot = synced.minutes.absDir;
  const headSha = synced.minutes.resolvedCommit;

  const state = await readState(join(kbRoot, "_meta", "state.json"), deps.readFile);
  const sinceSha = state?.last_processed_sha ?? null;

  const changed = await changedMinutesFiles(
    minutesRoot,
    sinceSha,
    headSha,
    deps.exec,
    config.minutes.exclude,
  );
  if (changed.length === 0) {
    logger.info("変更された議事録がありません。PR を作成しません。");
    return {
      created: false,
      reason: "no-changes",
      counts: emptyCounts(),
      domains: emptyDomains(),
      fileCount: 0,
    };
  }

  // 冪等性: 同一 head SHA の open PR が既にあれば skip(実 PR 時のみ gh に触れる)。
  if (deps.realPr) {
    const existing = findExistingPr(
      await deps.gh.listPullRequests(config.kb.repo, { state: "open" }),
      headSha,
    );
    if (existing) {
      logger.info("同一 head の PR が既存のため skip(冪等)", { prUrl: existing.url });
      return {
        created: false,
        reason: "already-exists",
        prUrl: existing.url,
        counts: emptyCounts(),
        domains: emptyDomains(),
        fileCount: 0,
      };
    }
  }

  const materializeDeps: MaterializeDeps = {
    idStore: deps.makeIdStore(kbRoot),
    now: deps.now,
    readFile: deps.readFile,
  };
  const counts = emptyCounts();
  const people = new Set<string>();
  const files: FileChange[] = [];
  // domain 再利用(§2-C): run 開始時の既存 domain を起点に、materialize した新設 domain を逐次
  // 追記して次の議事録の extract へ渡す(clone への書き込みはループ後なので in-memory で追う)。
  const domainSet = new Set(await listDomains(kbRoot, deps.readdir));
  const domains = emptyDomains();
  const clock = deps.monotonicMs ?? (() => performance.now());
  const timings: StageTimings = { extractMs: 0, reconcileMs: 0, materializeMs: 0 };

  for (const path of changed) {
    const content = await deps.readFile(join(minutesRoot, path));
    const participants = parseParticipants(content);
    const tExtract = clock();
    const { value: extraction } = await extractFromMinutes(
      { repo: config.minutes.repo, path, content, cwd: minutesRoot },
      { ...deps.extractDeps, existingDomains: [...domainSet] },
    );
    timings.extractMs += clock() - tExtract;
    counts.openQuestions += extraction.openQuestions.length;

    const candidates = [...extraction.decisions, ...extraction.learnings];
    domains.candidateCount += candidates.length;

    // reconcile は read-only な agentic search なので上限付き並列(§2-E)。リトライは reconcileCandidate
    // 内の withRetry(per-candidate・429/529/timeout)が担い、mapWithLimit は in-flight を絞るだけ。
    // 失敗候補は skip+記録して run 全体を落とさない(逐次時代の fail-fast からの意図的変更)。
    const tReconcile = clock();
    const verdicts = await mapWithLimit(candidates, deps.reconcileConcurrency, async (c) => {
      try {
        const { value } = await reconcileCandidate(c, kbRoot, deps.reconcileDeps);
        return { ok: true as const, verdict: value };
      } catch (e) {
        return { ok: false as const, error: e };
      }
    });
    timings.reconcileMs += clock() - tReconcile;

    // materialize は逐次(allocateId の順序性を保つ)。verdict は入力=候補順に集約済み。
    const tMaterialize = clock();
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i];
      const r = verdicts[i];
      if (c === undefined || r === undefined) continue;
      if (!r.ok) {
        counts.skip += 1;
        logger.warn("reconcile 失敗のため候補を skip", {
          candidate: candidateLabel(c),
          error: r.error instanceof Error ? r.error.message : String(r.error),
        });
        continue;
      }
      // 出典 = 議事録(meeting)。lines は候補ごとに異なるためここで合成する。
      const source: Source = {
        kind: "meeting",
        repo: config.minutes.repo,
        path,
        ref: headSha,
        ...(c.lines !== undefined ? { lines: c.lines } : {}),
      };
      const change = await materializeOne(
        {
          kbRoot,
          source,
          fallbackPeople: participants,
          candidate: c,
          verdict: r.verdict,
        },
        materializeDeps,
      );
      bump(counts, change.action);
      files.push(...change.files);
      addPeople(people, c);
      if (c.kind === "learning" && change.action === "new") {
        recordLearningDomain(c.domain, domainSet, domains, logger);
      }
    }
    timings.materializeMs += clock() - tMaterialize;
  }
  timings.extractMs = Math.round(timings.extractMs);
  timings.reconcileMs = Math.round(timings.reconcileMs);
  timings.materializeMs = Math.round(timings.materializeMs);
  logger.info("抽出サマリ", {
    candidates: domains.candidateCount,
    newDomains: domains.newDomains,
    reusedDomainCount: domains.reusedDomainCount,
    nearDuplicates: domains.nearDuplicates.length,
    timings,
  });

  if (files.length === 0) {
    logger.info("materialize 対象がありません。PR を作成しません。", {
      openQuestions: counts.openQuestions,
    });
    return { created: false, reason: "no-entries", counts, domains, timings, fileCount: 0 };
  }

  // clone に staging(validateRepo がディスクを読むため)+ カーソル/採番ファイルを PR に含める。
  for (const f of files) {
    await deps.writeFile(join(kbRoot, f.path), f.content);
  }
  const newState: ExtractorState = {
    last_processed_sha: headSha,
    last_run_at: deps.now().toISOString(),
  };
  await deps.writeFile(join(kbRoot, "_meta", "state.json"), serializeState(newState));
  files.push({ path: "_meta/state.json", content: serializeState(newState) });
  const counter = await deps.readFile(join(kbRoot, "_meta", "id-counter.json")).catch(() => null);
  if (counter !== null) files.push({ path: "_meta/id-counter.json", content: counter });

  const report = await deps.validate(kbRoot);
  if (!report.ok) {
    logger.error("validateRepo が失敗。PR を作成しません(§6.1 / ADR-0004 D2)。", {
      problems: report.problems.length,
    });
    return {
      created: false,
      reason: "validation-failed",
      counts,
      domains,
      timings,
      fileCount: files.length,
    };
  }

  const title = buildPrTitle(sinceSha, headSha);
  if (!deps.realPr) {
    logger.info("dry-run: 実 PR は作成しません(EXTRACTOR_REAL_PR 未設定)。", {
      files: files.length,
      title,
    });
    return { created: false, reason: "dry-run", counts, domains, timings, fileCount: files.length };
  }

  const pr = await deps.gh.createPullRequest({
    repo: config.kb.repo,
    head: `extract/${shortSha(headSha)}`,
    base: config.base_branch,
    title,
    body: buildPrBody(counts, domains, [...people]),
    files,
  });
  await deps.notifier.notifyPrCreated({ prUrl: pr.url, counts, people: [...people] });
  logger.info("抽出 PR を作成しました。", { prUrl: pr.url, files: files.length });
  return { created: true, prUrl: pr.url, counts, domains, timings, fileCount: files.length };
}
