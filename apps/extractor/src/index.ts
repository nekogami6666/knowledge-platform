/**
 * extractor エントリポイント(design.md C2 / §6.3)。env/config をロードし、実 seam を組み立てて runExtractor を呼ぶ。
 * 実 PR は EXTRACTOR_REAL_PR 時のみ(既定 dry-run)。GitHub 認証は実 PR 時のみ構築(dry-run を壊さない)。
 */
import { execFile } from "node:child_process";
import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
} from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { createLocalIdCounterStore, validateRepo } from "@stratum/kb-core";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { createFsConfigReader, loadExtractorConfig } from "./config.js";
import type { GitExec } from "./diff.js";
import { isRealPr, parseEnv, parsePositiveInt } from "./env.js";
import { createLogger } from "./logger.js";
import { createWebhookNotifier } from "./notify.js";
import { createGitRepoSyncer } from "./repos.js";
import { runExtractor } from "./run.js";

const execFileAsync = promisify(execFile);
const gitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return { stdout };
};

/** dry-run で GitHub 認証が無いときのスタブ(runExtractor は dry-run では gh を呼ばない)。 */
function nullGhClient(): GhClient {
  const fail = (): never => {
    throw new Error("GitHub 認証が未設定です(dry-run 中は gh を使いません)");
  };
  return {
    createPullRequest: async () => fail(),
    listPullRequests: async () => fail(),
    mergePullRequest: async () => fail(),
    getPullRequest: async () => fail(),
    commitFiles: async () => fail(),
    getFileContents: async () => fail(),
    listMergedPullRequests: async () => fail(),
    listPullRequestComments: async () => fail(),
    listPullRequestFiles: async () => fail(),
  };
}

async function main(): Promise<void> {
  const env = parseEnv();
  const secrets = [
    env.ANTHROPIC_AWS_API_KEY,
    env.GITHUB_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.DISCORD_OPS_WEBHOOK,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger(secrets);
  const realPr = isRealPr(env);
  const config = await loadExtractorConfig(createFsConfigReader(env.CONFIG_DIR));
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);
  const timeout = parsePositiveInt(env.EXTRACTOR_TIMEOUT_MS, 300_000);
  if (timeout.warning !== undefined) logger.warn(timeout.warning, { env: "EXTRACTOR_TIMEOUT_MS" });
  const concurrency = parsePositiveInt(env.EXTRACTOR_RECONCILE_CONCURRENCY, 4);
  if (concurrency.warning !== undefined)
    logger.warn(concurrency.warning, { env: "EXTRACTOR_RECONCILE_CONCURRENCY" });

  const summary = await runExtractor({
    config,
    syncer: createGitRepoSyncer(config, env.CLONES_DIR, gitExec),
    gh: realPr ? createGhClientFromEnv() : nullGhClient(),
    extractDeps: { promptStore, usage: nullUsageRecorder, timeoutMs: timeout.value },
    reconcileDeps: { promptStore, usage: nullUsageRecorder, timeoutMs: timeout.value },
    makeIdStore: (kbRoot) => createLocalIdCounterStore(kbRoot),
    validate: (kbRoot) => validateRepo(kbRoot),
    readFile: (p) => fsReadFile(p, "utf8"),
    writeFile: async (p, content) => {
      await mkdir(dirname(p), { recursive: true });
      await fsWriteFile(p, content, "utf8");
    },
    exec: gitExec,
    readdir: (dir) => fsReaddir(dir, { withFileTypes: true }),
    notifier: createWebhookNotifier(env.DISCORD_OPS_WEBHOOK),
    now: () => new Date(),
    logger,
    realPr,
    reconcileConcurrency: concurrency.value,
  });
  logger.info("extractor 完了", {
    created: summary.created,
    reason: summary.reason,
    files: summary.fileCount,
  });
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("extractor failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
