/**
 * discord-bot エントリポイント(design.md §6.2 C1)。
 * env / config をロードし、ロガー・Bot を組み立てて Discord にログインする。
 * PR-3a は骨格まで(/ask は stub)。検索パイプライン接続は PR-4。
 */
import { createFsConfigReader, loadChannels, loadMembers } from "./config.js";
import { createBot } from "./discord.js";
import { parseEnv } from "./env.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger();

  const reader = createFsConfigReader(env.CONFIG_DIR);
  const channels = await loadChannels(reader);
  const members = await loadMembers(reader);
  logger.info(
    { allowedChannels: channels.allow.length, members: members.members.length },
    "config loaded",
  );
  if (channels.allow.length === 0) {
    logger.warn("channels.allow が空です(default-deny)。どのチャンネルにも応答しません(§9.2)。");
  }

  const bot = createBot({ logger, channels });
  await bot.login(env.DISCORD_TOKEN);
  logger.info("discord-bot started");
}

main().catch((err) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
