/**
 * discord-bot エントリポイント(design.md §6.2 C1)。
 * env / config をロードし、SQLite ストア・RepoSyncer・プロンプトローダ・検索パイプラインを
 * 組み立てて /ask を配線し、Discord にログインする。
 */
import { randomUUID } from "node:crypto";
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { type AskDeps, handleAskRequest } from "./ask.js";
import { createFsConfigReader, loadChannels, loadMembers, loadOps, loadRepos } from "./config.js";
import { type AskHandler, createBot } from "./discord.js";
import { parseEnv } from "./env.js";
import { createLogger, withCorrelation } from "./logger.js";
import { createQaSearch } from "./qa-search.js";
import { createGitRepoSyncer } from "./repos.js";
import { createSqliteStore } from "./sqlite-store.js";
import { isoJst } from "./time.js";

async function main(): Promise<void> {
  const env = parseEnv();
  // §9.1: env の秘密「値」をログ最終行から伏字化(err.message 混入も捕捉。logger.ts (A))。
  // 全 AI 操作は Claude on AWS 経由(ADR-0009)。GitHub 認証(任意)も対象に含める。
  const secrets = [
    env.DISCORD_TOKEN,
    env.ANTHROPIC_AWS_API_KEY,
    env.GITHUB_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger("info", undefined, secrets);

  const reader = createFsConfigReader(env.CONFIG_DIR);
  const channels = await loadChannels(reader);
  const members = await loadMembers(reader);
  const reposConfig = await loadRepos(reader);
  const ops = await loadOps(reader);

  // 👍 代理マージ(§6.3): ops.yaml と GitHub 認証が両方揃ったときだけ有効(既定 OFF)。
  // 認証未整備(AUTH エラー)は機能 OFF として起動を続ける(bot の主務は /ask)。
  let gh: GhClient | undefined;
  if (ops.channel_id !== null && ops.kb_repo !== null) {
    try {
      gh = createGhClientFromEnv();
    } catch {
      logger.warn(
        "ops.yaml はあるが GitHub 認証(GITHUB_TOKEN か App trio)が無いため 👍 代理マージは無効です(ADR-0011)。",
      );
    }
  }
  logger.info(
    {
      allowedChannels: channels.allow.length,
      members: members.members.length,
      repos: reposConfig.repos.length,
      proxyMerge: gh !== undefined,
    },
    "config loaded",
  );
  if (channels.allow.length === 0) {
    logger.warn("channels.allow が空です(default-deny)。どのチャンネルにも応答しません(§9.2)。");
  }
  if (reposConfig.repos.length === 0) {
    logger.warn("repos.yaml が空です。検索対象リポがありません(§14 #5)。");
  }

  const store = createSqliteStore(env.DB_PATH);
  const syncer = createGitRepoSyncer(env.CLONES_DIR);
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);

  // 実 agentic search(runAgentSearch + §6.2 リトライ)を共有ファクトリで構築。
  // golden eval も同じ createQaSearch を使い、同一パイプラインを評価する(PR-5)。
  const search = createQaSearch({ usage: nullUsageRecorder });

  const onAsk: AskHandler = (question, ctx) => {
    const deps: AskDeps = {
      repos: reposConfig.repos,
      syncer,
      promptStore,
      store,
      clonesDir: env.CLONES_DIR,
      search,
      newId: () => randomUUID(),
      now: () => isoJst(),
      logError: (err) =>
        withCorrelation(logger, ctx.correlationId).error({ err }, "/ask pipeline error"),
    };
    return handleAskRequest(
      {
        question,
        discordUserId: ctx.userId,
        discordChannelId: ctx.channelId,
        threadId: null,
        correlationId: ctx.correlationId,
      },
      deps,
    );
  };

  const bot = createBot({
    logger,
    channels,
    store,
    onAsk,
    guildId: env.DISCORD_GUILD_ID,
    ops,
    gh,
    // §6.4 💡 捕捉: owner 写像 + triage/draft プロンプト + Agent SDK cwd(kb_repo/gh が無ければ OFF)。
    members,
    promptStore,
    clonesDir: env.CLONES_DIR,
  });
  await bot.login(env.DISCORD_TOKEN);
  logger.info("discord-bot started");
}

main().catch((err) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
