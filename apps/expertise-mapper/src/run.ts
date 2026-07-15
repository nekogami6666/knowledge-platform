/**
 * expertise-mapper 本体(design.md §6.6 ⑤-a / ADR-0017)。
 * フロー: evidence 収集(KB + commit・リポ失敗隔離)→ 既存 expertise.yaml を読む → 増分クラスタリング
 * (deep)→ 指標算出(決定的)→ 同一内容ならスキップ → checkout に実書き → validateRepo(赤なら
 * commit しない・ADR-0004 D2)→ dry-run ガード → commitFiles(main 直・ADR-0017 D5)→ risk:high 通知。
 * 全副作用は RunDeps 注入 seam(gap-tracker run.ts と同形)。
 */
import { join } from "node:path";
import type { GhClient } from "@stratum/gh-client";
import {
  type ExpertiseMap,
  parseExpertiseMap,
  sameExpertiseContent,
  serializeExpertiseMap,
} from "@stratum/kb-core";
import { type ClusterDeps, runClustering, type TopicRef } from "./cluster.js";
import { collectCommitEvidence } from "./commit-collector.js";
import type { ExpertiseMapperConfig } from "./config.js";
import { mergeEvidence } from "./evidence.js";
import { collectKbEvidence } from "./kb-collector.js";
import type { Logger } from "./logger.js";
import { buildExpertiseMap, computeTopics } from "./metrics.js";
import type { Notifier } from "./notify.js";
import { buildReport, reportDateKey, toJstIso } from "./report.js";

export const EXPERTISE_YAML = "expertise/expertise.yaml";

export interface RunDeps {
  config: ExpertiseMapperConfig;
  /** KB clone のルート(workflow の checkout 済み)。 */
  kbRoot: string;
  /** KB への書き込み(main 直 commit)用クライアント(GitHub App)。 */
  gh: Pick<GhClient, "commitFiles">;
  /** 対象リポの commit 読み取り用クライアント(read = PAT / write = App・ADR-0013 D4)。 */
  ghRead: Pick<GhClient, "listCommits">;
  /** クラスタリングの LLM seam(cwd は run が kbRoot を渡す)。 */
  clusterDeps: Omit<ClusterDeps, "cwd">;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** kb-collector 用(recursive readdir。不在は [])。 */
  readdir: (absDir: string) => Promise<string[]>;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  notifier: Notifier;
  now: () => Date;
  logger: Logger;
  /** 実 commit するか(既定 false = dry-run)。 */
  real: boolean;
}

export interface RunSummary {
  committed: boolean;
  reason: "committed" | "dry-run" | "no-materials" | "no-change" | "validate-failed";
  topics: number;
  highRisk: number;
  materials: number;
  unassigned: number;
}

export async function runExpertiseMapper(deps: RunDeps): Promise<RunSummary> {
  const { config, kbRoot, logger } = deps;
  const now = deps.now();

  // 1) evidence 収集(KB は常に。commit は targets があるときだけ — 空でも機能 OFF にしない)
  const kbMaterials = await collectKbEvidence(kbRoot, {
    logger,
    readFile: deps.readFile,
    readdir: deps.readdir,
  });
  const since = new Date(now.getTime() - config.window_days * 86_400_000).toISOString();
  const commits =
    config.targets.length > 0
      ? await collectCommitEvidence(config.targets, deps.ghRead, since, logger)
      : { materials: [], unattributedCommits: {}, failedRepos: [] };
  const pool = mergeEvidence([kbMaterials, commits.materials], commits.unattributedCommits);
  if (pool.materials.length === 0) {
    logger.info("material がありません(KB が空・targets 未設定)。何もせず終了します。");
    return {
      committed: false,
      reason: "no-materials",
      topics: 0,
      highRisk: 0,
      materials: 0,
      unassigned: 0,
    };
  }

  // 2) 既存マップ(増分クラスタリングの入力・名前安定の要)。
  // 読めない = 初回として扱う。**parse 失敗は fail-loud**(壊れたマップを黙って上書きしない)。
  let prevRaw: string | null = null;
  try {
    prevRaw = await deps.readFile(join(kbRoot, EXPERTISE_YAML));
  } catch {
    prevRaw = null;
  }
  const prev: ExpertiseMap | null =
    prevRaw === null ? null : parseExpertiseMap(prevRaw, EXPERTISE_YAML);
  const existingRefs: TopicRef[] = (prev?.topics ?? []).map((t) => ({
    topic: t.topic,
    label: t.label,
  }));

  // 3) クラスタリング(deep・是正リトライ 1 回 → fail-loud)→ 指標(決定的)
  const { value: outcome, usage } = await runClustering(
    existingRefs,
    pool.materials.map((m) => m.material),
    { ...deps.clusterDeps, cwd: kbRoot },
  );
  logger.info("クラスタリング完了", {
    materials: pool.materials.length,
    unassigned: outcome.unassigned.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  const topics = computeTopics(pool, outcome.assignments, outcome.topicLabels);
  const next = buildExpertiseMap(topics, toJstIso(now));
  const highRisk = topics.filter((t) => t.risk === "high");
  const base = {
    topics: topics.length,
    highRisk: highRisk.length,
    materials: pool.materials.length,
    unassigned: outcome.unassigned.length,
  };

  // 4) 変化判定(generated_at 除外)と当日レポートの有無 → commit するファイル集合
  const mapChanged = prev === null || !sameExpertiseContent(prev, next);
  const date = reportDateKey(now);
  const reportPath = `expertise/reports/${date}.md`;
  const reportExists = await deps
    .readFile(join(kbRoot, reportPath))
    .then(() => true)
    .catch(() => false);

  const files: { path: string; content: string }[] = [];
  if (mapChanged) {
    files.push({ path: EXPERTISE_YAML, content: serializeExpertiseMap(next) });
  }
  if (!reportExists) {
    files.push({
      path: reportPath,
      content: buildReport({
        date,
        prev,
        next,
        mapChanged,
        unassigned: outcome.unassigned,
        unattributedCommits: pool.unattributedCommits,
        failedRepos: commits.failedRepos,
        kbMaterials: kbMaterials.length,
        repoMaterials: commits.materials.length,
      }),
    });
  }
  if (files.length === 0) {
    logger.info("内容に変化がなく当日レポートも存在するため commit しません(再実行安全・§7.1)。");
    return { committed: false, reason: "no-change", ...base };
  }

  // 5) checkout に実書き → validateRepo(赤なら commit しない・ADR-0004 D2)
  for (const f of files) {
    await deps.writeFile(join(kbRoot, f.path), f.content);
  }
  const report = await deps.validate(kbRoot);
  if (!report.ok) {
    logger.error("validateRepo が赤のため commit しません。", {
      problems: report.problems.length,
    });
    return { committed: false, reason: "validate-failed", ...base };
  }

  // 6) dry-run ガード(既定)→ 実 commit(main 直・ADR-0017 D5)
  if (!deps.real) {
    logger.info("dry-run: commit は行いません。", {
      files: files.map((f) => f.path),
      mapChanged,
    });
    return { committed: false, reason: "dry-run", ...base };
  }
  const { sha } = await deps.gh.commitFiles({
    repo: config.kb.repo,
    branch: config.base_branch,
    message: `chore(expertise): 週次マップ更新 ${date}(topics ${topics.length} / high ${highRisk.length})`,
    files,
  });
  logger.info("expertise.yaml / レポートを commit しました。", { sha, files: files.length });

  // 7) risk:high 通知(実 commit 時のみ・§6.6 step4)
  await deps.notifier.notifyHighRisk(
    highRisk.map((t) => ({ topic: t.topic, label: t.label, top: t.people[0]?.name ?? "-" })),
    reportPath,
  );
  return { committed: true, reason: "committed", ...base };
}
