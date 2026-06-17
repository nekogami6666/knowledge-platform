/**
 * discord.js 配線(design.md §6.2)。/ask スラッシュコマンドの登録とハンドラ骨格。
 * 本ファイルはグルーコードで、統合テストで代替する(CLAUDE.md §12.2)。
 * PR-3a では /ask は stub 応答。実際の検索パイプライン(runAgentSearch)接続は PR-4。
 */
import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  SlashCommandBuilder,
} from "discord.js";
import type { Logger } from "pino";

/** /ask コマンド定義(登録は別途 REST で行う)。 */
export const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("社内ナレッジに質問する")
  .addStringOption((o) => o.setName("question").setDescription("質問内容").setRequired(true));

/** /ask の処理本体。PR-4 で検索パイプラインを注入する。 */
export type AskHandler = (
  question: string,
  ctx: { userId: string; channelId: string },
) => Promise<string>;

export interface BotDeps {
  logger: Logger;
  /** /ask の処理。未指定なら stub 応答(PR-3a)。 */
  onAsk?: AskHandler;
}

const stubHandler: AskHandler = async () =>
  "(PR-3a の stub 応答です。検索パイプラインは PR-4 で接続します。)";

/** Bot クライアントを構築する(login はしない。呼び出し側で client.login する)。 */
export function createBot(deps: BotDeps): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const onAsk = deps.onAsk ?? stubHandler;

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "ask") return;
    await handleAsk(interaction, onAsk, deps.logger);
  });

  return client;
}

async function handleAsk(
  interaction: ChatInputCommandInteraction,
  onAsk: AskHandler,
  logger: Logger,
): Promise<void> {
  const question = interaction.options.getString("question", true);
  // §6.2: エフェメラルにせずスレッド/通常返信で全員が後から参照できるようにする。
  await interaction.deferReply();
  try {
    const answer = await onAsk(question, {
      userId: interaction.user.id,
      channelId: interaction.channelId,
    });
    await interaction.editReply(answer);
  } catch (err) {
    logger.error({ err }, "/ask failed");
    await interaction.editReply("すみません、回答中にエラーが発生しました。");
  }
}
