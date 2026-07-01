/**
 * extractor オーケストレータ(design.md §6.3)。sync → cursor → diff → 各議事録を
 * extract → reconcile → materialize → clone に staging → validateRepo → 1日1PR → 通知。
 * 全副作用は注入 seam(syncer/gh/LLM/git/fs/validate/id/clock)。ユニットは fake のみ。
 * 実 PR は realPr フラグ時のみ(既定 dry-run)。カーソルは PR に含めて前進(merge 時に main 反映)。
 */
import { join } from "node:path";
import type { FileChange, GhClient } from "@stratum/gh-client";
import type { IdCounterStore } from "@stratum/kb-core";
import type { DecisionCandidate, LearningCandidate } from "./candidate.js";
import type { ExtractorConfig } from "./config.js";
import { type ExtractorState, readState, serializeState } from "./cursor.js";
import { changedMinutesFiles, type GitExec } from "./diff.js";
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
  notifier: Notifier;
  now: () => Date;
  logger: Logger;
  /** true で実 PR 作成、false で dry-run(既定)。 */
  realPr: boolean;
}

export interface RunSummary {
  created: boolean;
  reason?: string;
  prUrl?: string;
  counts: NotifyCounts;
  fileCount: number;
}

function emptyCounts(): NotifyCounts {
  return { new: 0, append: 0, supersede: 0, skip: 0, openQuestions: 0 };
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

/** 議事録の「参加者: a, b」行から参加者を抽出(owner/deciders フォールバック)。 */
export function parseParticipants(content: string): string[] {
  const m = /(?:参加者|participants?)\s*[:：]\s*(.+)/i.exec(content);
  if (m?.[1] === undefined) return [];
  return m[1]
    .split(/[,、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildPrBody(counts: NotifyCounts, people: readonly string[]): string {
  return [
    "議事録からの自動抽出(extractor)。内容を確認し、問題なければ 👍、修正は PR で直接編集してください。",
    `- 新規: ${counts.new}`,
    `- 出典追記: ${counts.append}`,
    `- 矛盾更新: ${counts.supersede}`,
    `- skip: ${counts.skip}`,
    `- 未解決の問い(未 materialize): ${counts.openQuestions}`,
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

  const changed = await changedMinutesFiles(minutesRoot, sinceSha, headSha, deps.exec);
  if (changed.length === 0) {
    logger.info("変更された議事録がありません。PR を作成しません。");
    return { created: false, reason: "no-changes", counts: emptyCounts(), fileCount: 0 };
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

  for (const path of changed) {
    const content = await deps.readFile(join(minutesRoot, path));
    const participants = parseParticipants(content);
    const { value: extraction } = await extractFromMinutes(
      { repo: config.minutes.repo, path, content, cwd: minutesRoot },
      deps.extractDeps,
    );
    counts.openQuestions += extraction.openQuestions.length;
    for (const c of [...extraction.decisions, ...extraction.learnings]) {
      const { value: verdict } = await reconcileCandidate(c, kbRoot, deps.reconcileDeps);
      const change = await materializeOne(
        {
          kbRoot,
          minutesRepo: config.minutes.repo,
          minutesPath: path,
          minutesRef: headSha,
          fallbackPeople: participants,
          candidate: c,
          verdict,
        },
        materializeDeps,
      );
      bump(counts, change.action);
      files.push(...change.files);
      addPeople(people, c);
    }
  }

  if (files.length === 0) {
    logger.info("materialize 対象がありません。PR を作成しません。", {
      openQuestions: counts.openQuestions,
    });
    return { created: false, reason: "no-entries", counts, fileCount: 0 };
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
    return { created: false, reason: "validation-failed", counts, fileCount: files.length };
  }

  const title = buildPrTitle(sinceSha, headSha);
  if (!deps.realPr) {
    logger.info("dry-run: 実 PR は作成しません(EXTRACTOR_REAL_PR 未設定)。", {
      files: files.length,
      title,
    });
    return { created: false, reason: "dry-run", counts, fileCount: files.length };
  }

  const pr = await deps.gh.createPullRequest({
    repo: config.kb.repo,
    head: `extract/${shortSha(headSha)}`,
    base: config.base_branch,
    title,
    body: buildPrBody(counts, [...people]),
    files,
  });
  await deps.notifier.notifyPrCreated({ prUrl: pr.url, counts, people: [...people] });
  logger.info("抽出 PR を作成しました。", { prUrl: pr.url, files: files.length });
  return { created: true, prUrl: pr.url, counts, fileCount: files.length };
}
