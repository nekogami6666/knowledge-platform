/**
 * pr-miner エントリポイント(design.md §6.4 ③-c)。env/config をロードし、実 seam を組み立てて runPrMiner を呼ぶ。
 * 実 PR は PR_MINER_REAL 時のみ(既定 dry-run)。GitHub 認証は「PR 読み取り」に常に必要なので、
 * targets 非空なら dry-run でも構築する(targets 空なら gh を作らず正常終了)。
 * KB clone は workflow の checkout(KB_ROOT)に任せ、アプリ内 clone は持たない。
 */
import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createGhClientFromAuth, createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { createLocalIdCounterStore, validateRepo } from "@stratum/kb-core";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { createFsConfigReader, loadPrMinerConfig } from "./config.js";
import { isRealPr, parseEnv, parsePositiveInt } from "./env.js";
import { createLogger } from "./logger.js";
import { createWebhookNotifier } from "./notify.js";
import { type RunDeps, runPrMiner } from "./run.js";

/** targets 空(機能 OFF)のときのスタブ。runPrMiner は disabled 分岐で gh を呼ばない。 */
function nullGhClient(): GhClient {
  const fail = (): never => {
    throw new Error("GitHub 認証は未設定です(targets が空のため gh は使いません)");
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
    env.GITHUB_READ_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.DISCORD_OPS_WEBHOOK,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger(secrets);
  const realPr = isRealPr(env);
  const config = await loadPrMinerConfig(createFsConfigReader(env.CONFIG_DIR));
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);
  const timeout = parsePositiveInt(env.PR_MINER_TIMEOUT_MS, 300_000);
  if (timeout.warning !== undefined) logger.warn(timeout.warning, { env: "PR_MINER_TIMEOUT_MS" });
  const concurrency = parsePositiveInt(env.PR_MINER_RECONCILE_CONCURRENCY, 4);
  if (concurrency.warning !== undefined)
    logger.warn(concurrency.warning, { env: "PR_MINER_RECONCILE_CONCURRENCY" });

  // targets 非空のときだけ GitHub 認証を構築(PR 読み取りに必要。dry-run でも読み取りはする)。
  // GITHUB_READ_TOKEN があれば読み取りだけ PAT に分離(read = PAT / write = App・ADR-0013 D4)。
  const enabled = config.targets.length > 0;
  const gh = enabled ? createGhClientFromEnv() : nullGhClient();
  const readToken = env.GITHUB_READ_TOKEN;
  const ghRead =
    enabled && readToken !== undefined && readToken.length > 0
      ? createGhClientFromAuth({ kind: "token", token: readToken })
      : gh;
  const deps: RunDeps = {
    config,
    kbRoot: env.KB_ROOT,
    gh,
    ghRead,
    extractDeps: { promptStore, usage: nullUsageRecorder, timeoutMs: timeout.value },
    reconcileDeps: {
      promptStore,
      usage: nullUsageRecorder,
      timeoutMs: timeout.value,
      app: "pr-miner",
    },
    makeIdStore: (kbRoot) => createLocalIdCounterStore(kbRoot),
    validate: (kbRoot) => validateRepo(kbRoot),
    readFile: (p) => fsReadFile(p, "utf8"),
    writeFile: async (p, content) => {
      await mkdir(dirname(p), { recursive: true });
      await fsWriteFile(p, content, "utf8");
    },
    readdir: (dir) => fsReaddir(dir, { withFileTypes: true }),
    notifier: createWebhookNotifier(env.DISCORD_OPS_WEBHOOK),
    now: () => new Date(),
    logger,
    realPr,
    reconcileConcurrency: concurrency.value,
  };

  const summary = await runPrMiner(deps);
  logger.info("pr-miner 完了", {
    created: summary.created,
    reason: summary.reason,
    files: summary.fileCount,
    minedPrs: summary.minedPrs,
  });
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("pr-miner failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
