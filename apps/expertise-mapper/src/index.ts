/**
 * expertise-mapper エントリポイント(design.md §6.6 ⑤-a / ADR-0017)。
 * env/config をロードし、実 seam を組み立てて runExpertiseMapper を呼ぶ。
 * 実 commit は EXPERTISE_REAL 時のみ(既定 dry-run)。KB clone は workflow の checkout(KB_ROOT)。
 * GitHub 認証: 対象リポの commit 読み取り = GITHUB_READ_TOKEN(PAT)/ KB への main 直 commit = App
 * (read = PAT / write = App・ADR-0013 D4。pr-miner と同じ)。
 */
import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createGhClientFromAuth, createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { validateRepo } from "@stratum/kb-core";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { createFsConfigReader, loadExpertiseMapperConfig } from "./config.js";
import { isReal, parseEnv, parsePositiveInt } from "./env.js";
import { createLogger } from "./logger.js";
import { createWebhookNotifier } from "./notify.js";
import { type RunDeps, runExpertiseMapper } from "./run.js";

/** 認証未整備のときのスタブ(触った時点で fail-loud。dry-run + targets 空なら触られない)。 */
function failLoudGhClient(reason: string): GhClient {
  const fail = (): never => {
    throw new Error(reason);
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
  const env = parseEnv();
  const secrets = [
    env.ANTHROPIC_AWS_API_KEY,
    env.GITHUB_TOKEN,
    env.GITHUB_READ_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.DISCORD_OPS_WEBHOOK,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger(secrets);
  const config = await loadExpertiseMapperConfig(createFsConfigReader(env.CONFIG_DIR));
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);
  const timeout = parsePositiveInt(env.EXPERTISE_TIMEOUT_MS, 300_000);
  if (timeout.warning !== undefined) logger.warn(timeout.warning, { env: "EXPERTISE_TIMEOUT_MS" });

  // 書き込み(App)は実 commit 時に必須(fail-loud)。読み取りは PAT 優先。
  let envClient: GhClient | undefined;
  try {
    envClient = createGhClientFromEnv();
  } catch {
    envClient = undefined;
  }
  const gh =
    envClient ??
    failLoudGhClient(
      "GitHub 認証(App trio か GITHUB_TOKEN)がありません(実 commit に必要・ADR-0017 D5)",
    );
  const readToken = env.GITHUB_READ_TOKEN;
  const ghRead =
    readToken !== undefined && readToken.length > 0
      ? createGhClientFromAuth({ kind: "token", token: readToken })
      : (envClient ??
        failLoudGhClient(
          "対象リポの読み取り認証がありません(GITHUB_READ_TOKEN か App/GITHUB_TOKEN を設定)",
        ));

  const deps: RunDeps = {
    config,
    kbRoot: env.KB_ROOT,
    gh,
    ghRead,
    clusterDeps: {
      promptStore,
      usage: nullUsageRecorder,
      timeoutMs: timeout.value,
    },
    readFile: (p) => fsReadFile(p, "utf8"),
    writeFile: async (p, content) => {
      await mkdir(dirname(p), { recursive: true });
      await fsWriteFile(p, content, "utf8");
    },
    readdir: async (dir) => {
      try {
        return (await fsReaddir(dir, { recursive: true })) as string[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    validate: (kbRoot) => validateRepo(kbRoot),
    notifier: createWebhookNotifier(env.DISCORD_OPS_WEBHOOK),
    now: () => new Date(),
    logger,
    real: isReal(env),
  };

  const summary = await runExpertiseMapper(deps);
  logger.info("expertise-mapper 完了", { ...summary });
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("expertise-mapper failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
