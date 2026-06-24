/**
 * discord-bot エントリポイント(design.md §6.2 C1)。
 * env / config をロードし、SQLite ストア・RepoSyncer・プロンプトローダ・検索パイプラインを
 * 組み立てて /ask を配線し、Discord にログインする。
 */
import { randomUUID } from "node:crypto";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { type AskDeps, handleAskRequest } from "./ask.js";
import { createFsConfigReader, loadChannels, loadMembers, loadRepos } from "./config.js";
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
  // ANTHROPIC_API_KEY は Claude Platform on AWS 時 undefined になりうる。ワークスペースキーも伏字対象に含める(ADR-0008)。
  const logger = createLogger(
    "info",
    undefined,
    [env.DISCORD_TOKEN, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AWS_API_KEY].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    ),
  );

  const reader = createFsConfigReader(env.CONFIG_DIR);
  const channels = await loadChannels(reader);
  const members = await loadMembers(reader);
  const reposConfig = await loadRepos(reader);
  logger.info(
    {
      allowedChannels: channels.allow.length,
      members: members.members.length,
      repos: reposConfig.repos.length,
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

  const bot = createBot({ logger, channels, store, onAsk, guildId: env.DISCORD_GUILD_ID });
  await bot.login(env.DISCORD_TOKEN);
  logger.info("discord-bot started");
}

main().catch((err) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
