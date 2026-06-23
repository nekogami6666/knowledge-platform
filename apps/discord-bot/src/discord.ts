/**
 * discord.js 配線(design.md §6.2)。/ask スラッシュコマンドと 👍👎 フィードバックのハンドラ。
 * 本ファイルはグルーコード(統合テストで代替、CLAUDE.md §12.2)。判定ロジックは純関数に抽出して単体テストする。
 * PR-4b: rate-limit / 直列キュー / 実パイプライン(onAsk)/ 👍👎 ボタンを配線。
 */
import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  SlashCommandBuilder,
} from "discord.js";
import type { Logger } from "pino";
import type { AskResult } from "./ask.js";
import { SerialQueue } from "./concurrency.js";
import { type ChannelsConfig, isChannelAllowed } from "./config.js";
import type { BotStore } from "./db.js";
import { withCorrelation } from "./logger.js";
import { isoJst } from "./time.js";

/** /ask コマンド定義(登録は別途 REST で行う)。 */
export const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("社内ナレッジに質問する")
  .addStringOption((o) => o.setName("question").setDescription("質問内容").setRequired(true));

/** /ask の処理本体(PR-4a の handleAskRequest を index.ts で包んで注入する)。 */
export type AskHandler = (
  question: string,
  ctx: { userId: string; channelId: string; correlationId: string },
) => Promise<AskResult>;

export interface BotDeps {
  logger: Logger;
  /** §9.2: 閲覧許可チャンネル(default-deny)。allow に無いチャンネルでは応答しない。 */
  channels: ChannelsConfig;
  /** 運用状態ストア(rate-limit / フィードバック記録 / 👎 のキュー投入)。ask 側と共有する。 */
  store: BotStore;
  /** /ask の処理。未指定なら stub 応答。 */
  onAsk?: AskHandler;
}

/** §9.2 default-deny: 許可されないチャンネルへの拒否メッセージ。許可なら null。 */
export const DENY_MESSAGE = "このチャンネルでは利用できません(§9.2)。";
export function denyReason(channels: ChannelsConfig, channelId: string): string | null {
  return isChannelAllowed(channels, channelId) ? null : DENY_MESSAGE;
}

// レート制限(§6.2 直列+制御 / §13 専門家負荷)。固定 10 分バケットで user/channel 別にカウント。
const RATE_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMITS = { user: 5, channel: 20 } as const;
const RATE_LIMIT_MESSAGE = "リクエストが多すぎます。少し時間をおいて再度お試しください。";

/** rate_limits の window_start(10 分バケットのキー)。 */
export function windowKey(epochMs: number): string {
  return String(Math.floor(epochMs / RATE_WINDOW_MS));
}

/** 👍👎 ボタン行。customId は "fb:up:<queryId>" / "fb:down:<queryId>"。 */
export function feedbackButtons(queryId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`fb:up:${queryId}`)
      .setLabel("👍")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`fb:down:${queryId}`)
      .setLabel("👎")
      .setStyle(ButtonStyle.Danger),
  );
}

/** ボタン customId を解析(不正なら null)。 */
export function parseFeedbackCustomId(
  customId: string,
): { value: "up" | "down"; queryId: string } | null {
  const m = /^fb:(up|down):(.+)$/.exec(customId);
  if (m === null) return null;
  return { value: m[1] as "up" | "down", queryId: m[2] as string };
}

const stubHandler: AskHandler = async () => ({
  answerText: "(stub 応答。index.ts で onAsk を注入してください。)",
  status: "error",
  queryId: "",
});

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
  // §6.2: /ask は直列処理(同時多発でもクラッシュしない)。
  const queue = new SerialQueue();

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === "ask") {
      await handleAsk(interaction, onAsk, deps, queue);
    } else if (interaction.isButton()) {
      await handleButton(interaction, deps);
    }
  });

  return client;
}

async function handleAsk(
  interaction: ChatInputCommandInteraction,
  onAsk: AskHandler,
  deps: BotDeps,
  queue: SerialQueue,
): Promise<void> {
  const { logger, channels, store } = deps;
  // §9.2 default-deny: 許可外チャンネルでは onAsk を呼ばず ephemeral で拒否する。
  const denied = denyReason(channels, interaction.channelId);
  if (denied !== null) {
    await interaction.reply({ content: denied, ephemeral: true });
    return;
  }

  // §6.2/§13 rate-limit: user/channel 別の 10 分バケット。超過は ephemeral 拒否。
  // user を先に評価し、超過時は `||` 短絡で channel を増やさない(連打が channel 予算を前借りしない)。
  const win = windowKey(Date.now());
  const overLimit =
    !store.hitRateLimit(`user:${interaction.user.id}`, "ask", win, RATE_LIMITS.user).allowed ||
    !store.hitRateLimit(`channel:${interaction.channelId}`, "ask", win, RATE_LIMITS.channel)
      .allowed;
  if (overLimit) {
    await interaction.reply({ content: RATE_LIMIT_MESSAGE, ephemeral: true });
    return;
  }

  // §7.4: /ask ごとに相関 ID を発番し、以降のログに付与する。
  const correlationId = randomUUID();
  const log = withCorrelation(logger, correlationId);
  const question = interaction.options.getString("question", true);
  // §6.2: エフェメラルにせず全員が後から参照できる公開返信にする。
  await interaction.deferReply();
  try {
    const result = await queue.enqueue(() =>
      onAsk(question, {
        userId: interaction.user.id,
        channelId: interaction.channelId,
        correlationId,
      }),
    );
    // 出典付き回答にのみ 👍👎 を付ける(未回答/エラーには付けない)。
    const components =
      result.status === "answered" && result.queryId !== ""
        ? [feedbackButtons(result.queryId)]
        : [];
    await interaction.editReply({ content: result.answerText, components });
  } catch (err) {
    // パイプライン内部エラーは AskResult で返るため、ここに来るのは主に Discord 送信失敗。
    log.error({ err }, "/ask reply failed");
    await interaction.editReply("すみません、回答の送信に失敗しました。");
  }
}

export async function handleButton(interaction: ButtonInteraction, deps: BotDeps): Promise<void> {
  const parsed = parseFeedbackCustomId(interaction.customId);
  if (parsed === null) return;
  // 相関 ID には対象 queryId を使い、フィードバック操作を該当クエリに紐づけて追跡する(§7.4)。
  const log = withCorrelation(deps.logger, parsed.queryId);
  try {
    deps.store.setFeedback(parsed.queryId, parsed.value);
    if (parsed.value === "down") {
      // §6.2 step6: 👎 はフライホイール燃料として questions キューへ(git には書かない)。
      deps.store.queueAction({
        id: randomUUID(),
        type: "question_queue",
        queryId: parsed.queryId,
        payloadJson: null,
        state: "pending",
        createdAt: isoJst(),
      });
    }
    await interaction.reply({
      content:
        parsed.value === "up"
          ? "ありがとうございます!"
          : "フィードバックを記録しました。改善に役立てます。",
      ephemeral: true,
    });
  } catch (err) {
    // store throw(SQLite ロック等)や送信失敗で interaction を未 ack のまま落とさない。
    log.error({ err }, "feedback handling failed");
    // 未応答ならガード付きで ephemeral 通知。二重応答や再失敗はこれ以上できることが無いので握りつぶす。
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: "フィードバックの記録に失敗しました。",
          ephemeral: true,
        });
      } catch {
        // noop: Discord への通知自体が失敗。ログ済みなのでこれ以上は何もしない。
      }
    }
  }
}
