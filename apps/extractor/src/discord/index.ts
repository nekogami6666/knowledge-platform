/**
 * discord ソースの composition root(ADR-0033)。VM systemd timer から
 * `node apps/extractor/dist/discord/index.js` で起動する(Actions 夜間の ../index.ts とは別経路)。
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
import { openCollectorSession } from "@stratum/discord-bot/collector";
import {
  createFsConfigReader as createBotConfigReader,
  loadChannels,
} from "@stratum/discord-bot/config";
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { newId, validateRepo } from "@stratum/kb-core";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { type GitExec, syncKb, withCloneToken } from "@stratum/shared";
import { parsePositiveInt } from "../env.js";
import { createLogger } from "../logger.js";
import { createWebhookNotifier } from "../notify.js";
import { loadDiscordSourceConfig } from "./config.js";
import { isDiscordReal, parseDiscordEnv } from "./env.js";
import { runDiscordSource } from "./run.js";

const execFileAsync = promisify(execFile);
const gitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return { stdout };
};

/** dry-run 用スタブ(dry-run は gh に触れない設計。触れたら設計バグとして fail-loud)。 */
function nullGhClient(): GhClient {
  const fail = (): never => {
    throw new Error("dry-run 中に gh が呼ばれました(設計バグ)");
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
    listCommits: async () => fail(),
  };
}

async function main(): Promise<void> {
  const env = parseDiscordEnv();
  const secrets = [
    env.DISCORD_TOKEN,
    env.ANTHROPIC_AWS_API_KEY,
    env.GIT_CLONE_TOKEN,
    env.GITHUB_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.DISCORD_OPS_WEBHOOK,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger(secrets);
  const real = isDiscordReal(env);
  const config = await loadDiscordSourceConfig({
    read: (name) => fsReadFile(`${env.CONFIG_DIR}/${name}`, "utf8"),
  });
  const channelsConfig = await loadChannels(createBotConfigReader(env.CHANNELS_CONFIG_DIR));
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);
  const timeout = parsePositiveInt(env.EXTRACTOR_DISCORD_TIMEOUT_MS, 300_000);
  if (timeout.warning !== undefined)
    logger.warn(timeout.warning, { env: "EXTRACTOR_DISCORD_TIMEOUT_MS" });
  const concurrency = parsePositiveInt(env.EXTRACTOR_DISCORD_RECONCILE_CONCURRENCY, 4);
  if (concurrency.warning !== undefined)
    logger.warn(concurrency.warning, { env: "EXTRACTOR_DISCORD_RECONCILE_CONCURRENCY" });

  const summary = await runDiscordSource({
    config,
    channelsConfig,
    openSession: () => openCollectorSession({ token: env.DISCORD_TOKEN }),
    syncKb: () =>
      syncKb(
        {
          dir: config.kb.dir,
          baseBranch: config.base_branch,
          ...(config.kb.url !== undefined
            ? { url: withCloneToken(config.kb.url, env.GIT_CLONE_TOKEN) }
            : {}),
        },
        env.CLONES_DIR,
        gitExec,
      ),
    gh: real ? createGhClientFromEnv() : nullGhClient(),
    extractDeps: { promptStore, usage: nullUsageRecorder, timeoutMs: timeout.value },
    reconcileDeps: {
      promptStore,
      usage: nullUsageRecorder,
      timeoutMs: timeout.value,
      app: "extractor-discord",
    },
    makeId: (kind, now) => newId(kind, { ...(now !== undefined ? { now } : {}) }),
    validate: (kbRoot) => validateRepo(kbRoot),
    readFile: (p) => fsReadFile(p, "utf8"),
    writeFile: async (p, content) => {
      await mkdir(dirname(p), { recursive: true });
      await fsWriteFile(p, content, "utf8");
    },
    readdir: (dir) => fsReaddir(dir, { withFileTypes: true }),
    listFiles: async (dir) => {
      try {
        return (await fsReaddir(dir, { recursive: true })) as string[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    notifier: createWebhookNotifier(env.DISCORD_OPS_WEBHOOK, undefined, logger),
    now: () => new Date(),
    logger,
    real,
    reconcileConcurrency: concurrency.value,
  });
  logger.info("extractor discord ソース完了", { ...summary });
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("extractor-discord failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
