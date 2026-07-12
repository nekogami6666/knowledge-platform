/**
 * discord.js 配線(design.md §6.2)。/ask スラッシュコマンドと 👍👎 フィードバックのハンドラ。
 * 本ファイルはグルーコード(統合テストで代替、CLAUDE.md §12.2)。判定ロジックは純関数に抽出して単体テストする。
 * PR-4b: rate-limit / 直列キュー / 実パイプライン(onAsk)/ 👍👎 ボタンを配線。
 */
import { randomUUID } from "node:crypto";
import type { GhClient } from "@stratum/gh-client";
import { qIdSchema } from "@stratum/kb-core";
import type { PromptStore } from "@stratum/llm";
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
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  Partials,
  type PartialUser,
  SlashCommandBuilder,
  type User,
} from "discord.js";
import type { Logger } from "pino";
import type { AskResult } from "./ask.js";
import { handleLightbulb } from "./capture.js";
import { SerialQueue } from "./concurrency.js";
import {
  type ChannelsConfig,
  isChannelAllowed,
  type MembersConfig,
  type OpsConfig,
  type VoiceConfig,
} from "./config.js";
import type { BotStore } from "./db.js";
import { withCorrelation } from "./logger.js";
import { isoJst } from "./time.js";
import { handleVoiceCorrection, handleVoiceMemo } from "./voice.js";

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
  /**
   * スラッシュコマンドの登録先ギルド(env DISCORD_GUILD_ID)。指定時はそのギルドへ即時反映、
   * 未指定はグローバル登録(全サーバーに反映されるが最大 1 時間かかる)。テストサーバーでは指定推奨。
   */
  guildId?: string;
  /** 👍 代理マージの設定(§6.3)。未設定(または channel_id/kb_repo が null)なら機能 OFF。 */
  ops?: OpsConfig;
  /** GitHub クライアント(代理マージ・💡 捕捉用)。認証未整備なら undefined = 機能 OFF。 */
  gh?: GhClient;
  /** members.yaml(💡 捕捉の owner 写像・§6.4)。未整備なら空で可。 */
  members?: MembersConfig;
  /** プロンプトローダ(💡 捕捉の triage/draft・§6.4)。未指定なら 💡 捕捉 OFF。 */
  promptStore?: PromptStore;
  /** Agent SDK の cwd(💡 捕捉はツール無し単発だが必須項目)。bot は CLONES_DIR。 */
  clonesDir?: string;
  /** voice-memo(§6.4 ③-b)。未指定または channel_id が null なら機能 OFF。 */
  voice?: VoiceConfig;
  /** voice-memo 受付直後にパイプライン(voice-pipeline.ts)を起こす hook(PR-V3)。 */
  onVoiceMemoQueued?: () => void;
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

/**
 * Gateway intents(§9.5 最小権限)。/ask と 👍👎 ボタンは interaction なので `Guilds` で足りる。追加分:
 * - `GuildMessageReactions`: 👍 代理マージ(§6.3)と 💡 捕捉(§6.4)が guild のリアクションを拾う。
 * - `GuildMessages`: gap 回答捕捉(§6.5 ④UI・PR-D2)が依頼メッセージへの「返信」を MessageCreate で検知する
 *   (非 privileged)。
 * - `DirectMessageReactions`: 💡 捕捉のレビュー DM への 👍(§6.4・PR-E1b)を拾う(非 privileged)。
 * - `MessageContent`(privileged・Developer Portal で有効化。§9.2 が想定済み): 代理マージの PR URL と
 *   gap 依頼の q-ID を webhook 本文から読むために必要。
 */
export const BOT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessageReactions,
  GatewayIntentBits.MessageContent,
] as const;

/**
 * Partials(§6.3 代理マージ / §6.4 💡 DM)。webhook 通知や DM は bot のキャッシュに無いメッセージ・
 * チャンネルなので、リアクションイベントが partial で届く。fetch で実体化するために宣言が必須
 * (DM チャンネルは `Partials.Channel` が無いとイベント自体が発火しない)。
 */
export const BOT_PARTIALS = [
  Partials.Message,
  Partials.Reaction,
  Partials.User,
  Partials.Channel,
] as const;

/** Bot クライアントを構築する(login はしない。呼び出し側で client.login する)。 */
export function createBot(deps: BotDeps): Client {
  const client = new Client({ intents: [...BOT_INTENTS], partials: [...BOT_PARTIALS] });
  const onAsk = deps.onAsk ?? stubHandler;
  // §6.2: /ask は直列処理(同時多発でもクラッシュしない)。
  const queue = new SerialQueue();

  // 起動時に /ask を Discord へ登録する。guildId 指定ならそのギルドへ即時、未指定はグローバル
  // (反映に最大 1 時間)。登録失敗は致命ではないのでログのみで起動を続ける。
  client.once(Events.ClientReady, async (ready) => {
    const commands = [askCommand.toJSON()];
    try {
      // guildId 指定はそのギルドへ即時、未指定はグローバル登録(set の guildId 引数は string 必須)。
      if (deps.guildId !== undefined) {
        await ready.application.commands.set(commands, deps.guildId);
      } else {
        await ready.application.commands.set(commands);
      }
      deps.logger.info(
        { scope: deps.guildId !== undefined ? "guild" : "global", guildId: deps.guildId ?? null },
        "slash commands registered",
      );
    } catch (err) {
      withCorrelation(deps.logger, "startup").error({ err }, "slash command registration failed");
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === "ask") {
      await handleAsk(interaction, onAsk, deps, queue);
    } else if (interaction.isButton()) {
      await handleButton(interaction, deps);
    }
  });

  // §6.3: #stratum-ops の extractor 通知への 👍 で PR を代理マージ(ops/gh 未設定なら実質 no-op)。
  // §6.4 ③-a: 💡 でナレッジ候補を捕捉(kb_repo/gh/promptStore が無ければ実質 no-op)。
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleProxyMergeReaction(reaction, user, deps);
    await handleLightbulb(reaction, user, {
      logger: deps.logger,
      channels: deps.channels,
      store: deps.store,
      members: deps.members ?? { members: [] },
      cwd: deps.clonesDir ?? ".",
      ops: deps.ops,
      gh: deps.gh,
      promptStore: deps.promptStore,
    });
  });

  // §6.5 ④UI(PR-D2): gap 依頼(webhook)への「返信」を捕捉して gap_answer をキューへ。
  // §6.4 ③-b(PR-V1): #voice-memo への音声投稿を検知して voice_memo をキューへ(voice 未設定なら no-op)。
  // 受付後は onVoiceMemoQueued がパイプライン(STT → 単発 PR → 返信・PR-V3)を起こす。
  client.on(Events.MessageCreate, async (message) => {
    await handleGapAnswer(message, deps);
    const voiceDeps = {
      logger: deps.logger,
      channels: deps.channels,
      store: deps.store,
      ...(deps.voice !== undefined ? { voice: deps.voice } : {}),
    };
    await handleVoiceMemo(message, voiceDeps);
    // §6.4 L485(PR-V4): bot の記録返信への返信 = 訂正。voice 設定に依らず bot 返信マーカーで判定。
    await handleVoiceCorrection(message, voiceDeps);
    deps.onVoiceMemoQueued?.();
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

/** メッセージ本文から最初の GitHub PR URL を解析する(無ければ null)。 */
export function parseGithubPrUrl(text: string): { repo: string; number: number } | null {
  const m = /https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/.exec(text);
  if (m === null) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/** 代理マージの判定入力(discord.js から必要な値だけを剥がした純粋データ)。 */
export interface ProxyMergeInput {
  emojiName: string | null;
  channelId: string;
  /** メッセージが webhook 投稿なら webhook の ID、通常メッセージは null。 */
  messageWebhookId: string | null;
  reactorIsBot: boolean;
  content: string;
  ops: OpsConfig;
  /** DM ルート(§6.4 💡 capture のレビュー DM)。既定 false=guild の ops ルート(§6.3)。 */
  isDm?: boolean;
  /** メッセージが自 bot の投稿か(DM ルートの信頼境界。capture が送った DM のみ対象)。 */
  messageAuthorIsSelf?: boolean;
}

export type ProxyMergeDecision =
  | { merge: true; repo: string; number: number }
  | { merge: false; reason: string };

/**
 * 👍 代理マージのガード判定(§6.3 ops ルート / §6.4 DM ルート・純関数)。共通で
 * 👍 である / 人間のリアクション / 本文の PR URL が ops.kb_repo のもの、を要求する。ルート別:
 * - ops ルート(guild): #stratum-ops チャンネル + webhook 投稿(extractor / gap-tracker 通知)。
 * - DM ルート(§6.4): bot が起票者に送った capture レビュー DM(自 bot の投稿)。DM チャンネル自体が
 *   bot↔本人の信頼境界のため、チャンネル一致・webhook 判定は不要。
 */
export function proxyMergeDecision(input: ProxyMergeInput): ProxyMergeDecision {
  const { ops } = input;
  if (ops.kb_repo === null) return { merge: false, reason: "ops-config-off" };
  if (input.emojiName !== "👍") return { merge: false, reason: "not-thumbsup" };
  if (input.reactorIsBot) return { merge: false, reason: "bot-reactor" };

  if (input.isDm === true) {
    // DM は bot と本人の 2 者しか居ない。capture が送った DM(自 bot 投稿)のみを承認導線とする。
    if (input.messageAuthorIsSelf !== true) return { merge: false, reason: "not-self-dm" };
  } else {
    if (ops.channel_id === null) return { merge: false, reason: "ops-config-off" };
    if (input.channelId !== ops.channel_id) return { merge: false, reason: "not-ops-channel" };
    if (input.messageWebhookId === null) return { merge: false, reason: "not-webhook-message" };
  }

  const pr = parseGithubPrUrl(input.content);
  if (pr === null) return { merge: false, reason: "no-pr-url" };
  if (pr.repo !== ops.kb_repo) return { merge: false, reason: "repo-not-allowed" };
  return { merge: true, repo: pr.repo, number: pr.number };
}

/**
 * 👍 代理マージ(§6.3 ops ルート / §6.4 💡 capture の DM ルート)。
 * validate 赤(mergeable_state != clean)はマージしない(ADR-0004 D2)。マージ済みは冪等に案内のみ。
 * 例外は handleButton と同じ封じ込め(catch → log + 返信試行)。
 */
export async function handleProxyMergeReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  deps: BotDeps,
): Promise<void> {
  const { ops, gh } = deps;
  if (ops === undefined || gh === undefined) return; // 機能 OFF(設定か認証が無い)
  try {
    // webhook メッセージ・DM はキャッシュ外で partial として届くため、実体を fetch してから判定する。
    const r = reaction.partial ? await reaction.fetch() : reaction;
    const message = r.message.partial ? await r.message.fetch() : r.message;
    const reactor = user.partial ? await user.fetch() : user;
    const decision = proxyMergeDecision({
      emojiName: r.emoji.name,
      channelId: message.channelId,
      messageWebhookId: message.webhookId ?? null,
      reactorIsBot: reactor.bot,
      content: message.content,
      ops,
      // guildId=null は DM。messageAuthorIsSelf は capture が送った DM(自 bot 投稿)かの判定。
      isDm: message.guildId === null,
      messageAuthorIsSelf:
        message.author?.id !== undefined && message.author.id === message.client?.user?.id,
    });
    if (!decision.merge) return; // 対象外のリアクションには反応しない(通常運用で大量に発生する)

    const log = withCorrelation(deps.logger, `${decision.repo}#${decision.number}`);
    const pr = await gh.getPullRequest(decision.repo, decision.number);
    if (pr.merged || pr.state === "closed") {
      // 冪等: 二重 👍・bot 再起動後の再配送でも二重マージしない。
      await message.reply(`この PR は既に ${pr.merged ? "マージ" : "クローズ"}されています。`);
      return;
    }
    if (pr.mergeableState !== "clean") {
      // ADR-0004 D2: validate(CI)が赤い PR・競合中・算出中はマージしない。
      await message.reply(
        `⛔ マージしません: PR の状態が clean ではありません(${pr.mergeableState ?? "算出中"})。CI(validate)や競合を確認してください。`,
      );
      log.warn({ mergeableState: pr.mergeableState }, "proxy merge refused (not clean)");
      return;
    }
    await gh.mergePullRequest({ repo: decision.repo, number: decision.number });
    // 監査: 誰の 👍 でどの PR をマージしたかを SQLite に残す(§7.4)。
    deps.store.queueAction({
      id: randomUUID(),
      type: "pr_merge",
      queryId: null,
      payloadJson: JSON.stringify({
        repo: decision.repo,
        number: decision.number,
        messageId: message.id,
        userId: reactor.id,
      }),
      state: "done",
      createdAt: isoJst(),
    });
    await message.reply(`✅ マージしました: ${pr.url}(👍 by <@${reactor.id}>)`);
    log.info({ userId: reactor.id }, "proxy merged");
  } catch (err) {
    withCorrelation(deps.logger, "proxy-merge").error({ err }, "proxy merge failed");
    try {
      if (!reaction.message.partial) {
        await reaction.message.reply("❌ マージに失敗しました。ログを確認してください。");
      }
    } catch {
      // noop: 通知自体が失敗。ログ済みなのでこれ以上は何もしない。
    }
  }
}

// --- gap 回答捕捉(§6.5 ④UI / PR-D2)-----------------------------------------

/**
 * 依頼メッセージ(gap-tracker が webhook で投稿・末尾に q-ID)本文から q-ID を取り出す。
 * 抽出は本文スキャン、妥当性は kb-core の qIdSchema(型の唯一の正・CLAUDE.md §12.2)で確定する。
 */
export function extractQuestionId(text: string): string | null {
  const m = /q-\d{4}-\d{4}/.exec(text);
  if (m === null) return null;
  const parsed = qIdSchema.safeParse(m[0]);
  return parsed.success ? parsed.data : null;
}

/** gap 回答判定の入力(discord.js から必要な値だけを剥がした純粋データ)。 */
export interface GapAnswerInput {
  /** 返信者が bot かどうか(bot / webhook の投稿は回答として扱わない)。 */
  authorIsBot: boolean;
  /** 返信元(依頼)メッセージが webhook 投稿なら webhook ID、通常メッセージは null。 */
  referencedWebhookId: string | null;
  /** 返信元メッセージの本文(q-ID を抽出する)。 */
  referencedContent: string;
}

export type GapAnswerDecision =
  | { capture: true; questionId: string }
  | { capture: false; reason: string };

/**
 * gap 回答捕捉のガード判定(§6.5 ④UI・純関数)。すべて満たす場合のみ capture:
 * 人間の返信 / 返信元が webhook(依頼)投稿 / 返信元本文に q-ID がある。
 * この3点で「依頼への人間の返信」だけを拾う(extractor の PR 通知など他の webhook は q-ID を持たない)。
 */
export function gapAnswerDecision(input: GapAnswerInput): GapAnswerDecision {
  if (input.authorIsBot) return { capture: false, reason: "bot-author" };
  if (input.referencedWebhookId === null) {
    return { capture: false, reason: "not-webhook-reference" };
  }
  const questionId = extractQuestionId(input.referencedContent);
  if (questionId === null) return { capture: false, reason: "no-question-id" };
  return { capture: true, questionId };
}

/**
 * 依頼メッセージへの「返信」を捕捉して gap_answer を pending_actions へ積む(§6.5 ④UI / PR-D2)。
 * MessageCreate は全メッセージに発火するため、返信でない/bot の投稿は REST fetch 前に早期 return する。
 * gap-tracker(PR-D3)がこのキューを読み、KB エントリ化 → PR → answered 移動を行う。
 * 例外は封じ込め(catch → log)。ここで throw すると Gateway リスナが不安定になる。
 */
export async function handleGapAnswer(message: Message, deps: BotDeps): Promise<void> {
  try {
    // bot / webhook 自身の投稿と、返信でないメッセージは対象外(REST fetch を避けて早期 return)。
    if (message.author.bot) return;
    const referenceId = message.reference?.messageId;
    if (referenceId === undefined) return;

    // 返信元(依頼メッセージ)を取得。削除済みなどは fetchReference が throw → catch で握る。
    const referenced = await message.fetchReference();
    const decision = gapAnswerDecision({
      authorIsBot: message.author.bot,
      referencedWebhookId: referenced.webhookId ?? null,
      referencedContent: referenced.content,
    });
    if (!decision.capture) return;

    const log = withCorrelation(deps.logger, decision.questionId);
    // 回答の出典は Discord permalink(PR-D3 が Source kind:"discord" として使う)。
    deps.store.queueAction({
      id: randomUUID(),
      type: "gap_answer",
      queryId: null,
      payloadJson: JSON.stringify({
        questionId: decision.questionId,
        authorId: message.author.id,
        content: message.content,
        messageUrl: message.url,
      }),
      state: "pending",
      createdAt: isoJst(),
    });
    await message.react("✅"); // 回答者へ「受け取った」ことを示す ack(§6.5 ④UI)
    log.info({ authorId: message.author.id }, "gap answer captured");
  } catch (err) {
    withCorrelation(deps.logger, "gap-answer").error({ err }, "gap answer capture failed");
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

/**
 * voice-pipeline(PR-V3)用の Discord 送信 seam。channelId/messageId からスレッド返信、
 * userId から DM を送る(discord.js のグルー。パイプライン本体は discord.js に依存しない)。
 */
export function createClientMessenger(client: Client): {
  reply(channelId: string, messageId: string, content: string): Promise<void>;
  dm(userId: string, content: string): Promise<void>;
} {
  return {
    async reply(channelId, messageId, content) {
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !channel.isTextBased()) {
        throw new Error(`channel ${channelId} is not text-based`);
      }
      const message = await channel.messages.fetch(messageId);
      await message.reply(content);
    },
    async dm(userId, content) {
      const user = await client.users.fetch(userId);
      await user.send(content);
    },
  };
}
