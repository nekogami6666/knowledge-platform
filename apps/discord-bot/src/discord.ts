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
  type Channel,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type GuildBasedChannel,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  Partials,
  type PartialUser,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type User,
} from "discord.js";
import type { Logger } from "pino";
import { ackReaction, noticeAllowedOnce } from "./ack.js";
import type { AskResult } from "./ask.js";
import { handleLightbulb, jstDayKey } from "./capture.js";
import { SerialQueue } from "./concurrency.js";
import {
  type ChannelGateInput,
  type ChannelsConfig,
  isChannelAllowed,
  type OpsConfig,
  type VoiceConfig,
} from "./config.js";
import type { BotStore } from "./db.js";
import { type FreshnessApplyDeps, handleFreshnessReaction } from "./freshness-flow.js";
import { handleInterviewCommand, type InterviewCommandDeps } from "./interview-commands.js";
import {
  handleInterviewPanelButton,
  handleInterviewPersonSelect,
  handleInterviewTopicModal,
  handleInterviewTopicSelect,
  INTERVIEW_CUSTOM_ID_PREFIX,
  type InterviewPanelDeps,
} from "./interview-panel.js";
import { withCorrelation } from "./logger.js";
import { EMPTY_MEMBERS, type MembersLoader } from "./members.js";
import { aggregateStats, formatStatsMessage } from "./stats.js";
import { isoJst } from "./time.js";
import type { VcRecorderWatcher, VcSnapshot } from "./vc-recorder.js";
import { gateInputFromInteraction } from "./visibility.js";
import { handleVoiceCorrection, handleVoiceMemo } from "./voice.js";

/** /ask コマンド定義(登録は別途 REST で行う)。 */
export const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("社内ナレッジに質問する")
  .addStringOption((o) => o.setName("question").setDescription("質問内容").setRequired(true));

/** /stats コマンド定義(利用状況・👍👎 集計・§1.4 KPI)。応答は本人だけに見える ephemeral。 */
export const statsCommand = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Q&A の利用状況と 👍👎 評価の集計を表示する(自分だけに表示)");

/** /interview コマンド定義(ADR-0028 D5)。VC 録音が無効な環境では登録しない(commandsToRegister)。 */
export const interviewCommand = new SlashCommandBuilder()
  .setName("interview")
  .setDescription("インタビューセッション(VC 録音 → 文字起こし PR)を管理する")
  .addSubcommand((s) =>
    s
      .setName("start")
      .setDescription("インタビューセッションを開始する(専用 VC に入ると録音開始)")
      .addStringOption((o) =>
        o.setName("person").setDescription("対象者(誰に聞くか)").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("topic").setDescription("テーマ(何を聞くか)").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("kit")
          .setDescription("質問キットのパス(interviews/kits/ 配下・省略時は自動発見)"),
      ),
  )
  .addSubcommand((s) =>
    s.setName("status").setDescription("進行中のセッション状態を表示する(自分だけに表示)"),
  )
  .addSubcommand((s) => s.setName("cancel").setDescription("進行中のセッションを中止する"));

/**
 * 起動時に登録するコマンド一覧(純関数)。/interview は VC 録音機能
 * (voice.vc_channel_id + RECORDER_URL)が有効な環境 = interview deps が注入された環境でのみ登録する
 * (ADR-0028 D5: 無効環境でコマンドだけ見えて失敗する UI を作らない)。
 */
export function commandsToRegister(
  hasInterview: boolean,
): ReturnType<SlashCommandBuilder["toJSON"]>[] {
  return [
    askCommand.toJSON(),
    statsCommand.toJSON(),
    ...(hasInterview ? [interviewCommand.toJSON()] : []),
  ];
}

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
  getMembers?: MembersLoader;
  /** プロンプトローダ(💡 捕捉の triage/draft・§6.4)。未指定なら 💡 捕捉 OFF。 */
  promptStore?: PromptStore;
  /** Agent SDK の cwd(💡 捕捉はツール無し単発だが必須項目)。bot は CLONES_DIR。 */
  clonesDir?: string;
  /** voice-memo(§6.4 ③-b)。未指定または channel_id が null なら機能 OFF。 */
  voice?: VoiceConfig;
  /** voice-memo 受付直後にパイプライン(voice-pipeline.ts)を起こす hook(PR-V3)。 */
  onVoiceMemoQueued?: () => void;
  /** 鮮度確認 DM への 👍✏️🗑 応答(§6.7 / ADR-0019 D2)。gh か ops.kb_repo が無ければ OFF。 */
  freshness?: FreshnessApplyDeps;
  /** VC 録音の制御(§6.4 ③-b / ADR-0020)。voice.vc_channel_id + RECORDER_URL が無ければ OFF。 */
  vcRecorder?: Pick<VcRecorderWatcher, "handleSnapshot">;
  /** /interview(ADR-0028 D5)。VC 録音が無効な環境では未注入 = コマンド登録もしない。 */
  interview?: InterviewCommandDeps;
  /** 面談パネル(ADR-0028 UI)。vcEnabled + interview_panel_channel_id の環境でのみ注入。 */
  interviewPanel?: InterviewPanelDeps;
}

/**
 * 専用 VC の現在参加者(bot 除外)スナップショットを組み立てる(ADR-0020 / ADR-0028)。
 * VoiceStateUpdate と rotation/resume の fetchSnapshot(index.ts)で共用する。
 * チャンネルが見えない・VC でない場合は humanIds: [](= 0 人扱い)。
 */
export function buildVcSnapshot(
  channel: Channel | GuildBasedChannel | undefined | null,
  guildId: string,
  vcChannelId: string,
): VcSnapshot {
  const humanIds = channel?.isVoiceBased()
    ? [...channel.members.values()].filter((m) => !m.user.bot).map((m) => m.id)
    : [];
  return { guildId, channelId: vcChannelId, humanIds };
}

/** §9.2(ADR-0018): 読めないチャンネルへの拒否メッセージ。許可なら null。 */
export const DENY_MESSAGE = "このチャンネルでは利用できません(§9.2)。";
export function denyReason(channels: ChannelsConfig, gate: ChannelGateInput): string | null {
  return isChannelAllowed(channels, gate) ? null : DENY_MESSAGE;
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
  // VC 録音の入退室検知(§6.4 ③-b / ADR-0020 D3。非 privileged)。
  GatewayIntentBits.GuildVoiceStates,
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
    const commands = commandsToRegister(deps.interview !== undefined);
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
    // ADR-0018 D5: 可視チャンネルの監査ログ(bot が「何を読むか」を起動時に 1 回可視化)。
    for (const guild of ready.guilds.cache.values()) {
      const me = guild.members.me;
      const visible = guild.channels.cache
        .filter(
          (c) =>
            c.isTextBased() &&
            me !== null &&
            (c.permissionsFor(me, false)?.has(PermissionFlagsBits.ViewChannel) ?? false),
        )
        .map((c) => c.name);
      deps.logger.info(
        { guild: guild.name, count: visible.length, channels: visible },
        "visible channels(ADR-0018 監査)",
      );
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === "ask") {
      await handleAsk(interaction, onAsk, deps, queue);
    } else if (interaction.isChatInputCommand() && interaction.commandName === "stats") {
      await handleStats(interaction, deps);
    } else if (interaction.isChatInputCommand() && interaction.commandName === "interview") {
      // deps.interview 未注入ならコマンド自体を登録しない(commandsToRegister)ため通常ここには来ない。
      if (deps.interview !== undefined) await handleInterviewCommand(interaction, deps.interview);
    } else if (interaction.isButton()) {
      // 面談パネル(ADR-0028 UI)。panel deps 未注入なら無反応(パネル自体が存在しない環境)。
      if (interaction.customId.startsWith(INTERVIEW_CUSTOM_ID_PREFIX)) {
        if (deps.interviewPanel !== undefined) {
          await handleInterviewPanelButton(interaction, deps.interviewPanel);
        }
      } else {
        await handleButton(interaction, deps);
      }
    } else if (interaction.isUserSelectMenu()) {
      if (deps.interviewPanel !== undefined) {
        await handleInterviewPersonSelect(interaction, deps.interviewPanel);
      }
    } else if (interaction.isStringSelectMenu()) {
      if (deps.interviewPanel !== undefined) {
        await handleInterviewTopicSelect(interaction, deps.interviewPanel);
      }
    } else if (interaction.isModalSubmit()) {
      if (deps.interviewPanel !== undefined) {
        await handleInterviewTopicModal(interaction, deps.interviewPanel);
      }
    }
  });

  // §6.3: #stratum-ops の extractor 通知への 👍 で PR を代理マージ(ops/gh 未設定なら実質 no-op)。
  // §6.4 ③-a: 💡 でナレッジ候補を捕捉(kb_repo/gh/promptStore が無ければ実質 no-op)。
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleProxyMergeReaction(reaction, user, deps);
    // §6.7(ADR-0019 D2): 鮮度確認 DM への 👍✏️🗑(deps.freshness 未設定なら no-op)。
    await handleFreshnessReaction(reaction, user, deps);
    await handleLightbulb(reaction, user, {
      logger: deps.logger,
      channels: deps.channels,
      store: deps.store,
      getMembers: deps.getMembers ?? (async () => EMPTY_MEMBERS),
      cwd: deps.clonesDir ?? ".",
      ops: deps.ops,
      gh: deps.gh,
      promptStore: deps.promptStore,
    });
  });

  // §6.5 ④UI(PR-D2): gap 依頼(webhook)への「返信」を捕捉して gap_answer をキューへ。
  // §6.4 ③-b(PR-V1): #voice-memo への音声投稿を検知して voice_memo をキューへ(voice 未設定なら no-op)。
  // 受付後は onVoiceMemoQueued がパイプライン(STT → 単発 PR → 返信・PR-V3)を起こす。
  // §6.4 ③-b(ADR-0020): 専用 VC の入退室 → 録音制御(vcRecorder 未設定なら no-op)。
  // スナップショット(bot を除いた現在参加者)だけを渡し、開始/終了判定は vc-recorder.ts が持つ。
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const vcId = deps.voice?.vc_channel_id ?? null;
    const rec = deps.vcRecorder;
    if (vcId === null || rec === undefined) return;
    if (oldState.channelId !== vcId && newState.channelId !== vcId) return;
    const guild = newState.guild ?? oldState.guild;
    const snapshot = buildVcSnapshot(guild.channels.cache.get(vcId), guild.id, vcId);
    void rec.handleSnapshot(snapshot).catch((err) => {
      deps.logger.warn({ err }, "vc snapshot handling failed");
    });
  });

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
  // ADR-0018 D4: interaction は bot 不可視チャンネル・DM からも届くため、guild + 可視性を明示チェック。
  if (!interaction.inGuild()) {
    await interaction.reply({ content: DENY_MESSAGE, ephemeral: true });
    return;
  }
  const denied = denyReason(channels, gateInputFromInteraction(interaction));
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

/** 代理マージが設定不足で使えないときの案内(ADR-0030 D4。抑制つきで返す)。 */
export const PROXY_MERGE_OFF_MESSAGE = "代理マージは現在利用できません(設定が未完了です)。";

/**
 * 拒否理由 → ユーザー向け日本語(ADR-0030 D5・純関数)。null = 通知不要
 * (not-thumbsup / bot-reactor / no-pr-url / not-self-dm は通常運用で大量に出るノイズ)。
 * ops チャンネルはハードコードせず設定値から mention を組む(CLAUDE.md 鉄則)。
 */
export function proxyMergeRejectMessage(
  reason: string,
  opsChannelId: string | null,
): string | null {
  switch (reason) {
    case "not-ops-channel":
      return opsChannelId === null
        ? "PR のマージは bot の通知チャンネルに投稿された通知に 👍 でお願いします。"
        : `PR のマージは <#${opsChannelId}> の通知に 👍 でお願いします。`;
    case "not-webhook-message":
      return "bot の通知メッセージにのみ 👍 でマージできます。";
    case "repo-not-allowed":
      return "このリポジトリの PR は代理マージの対象外です。";
    case "ops-config-off":
      return PROXY_MERGE_OFF_MESSAGE;
    default:
      return null;
  }
}

/**
 * 拒否理由を返すべきか(ADR-0030 D5・純関数)。👍 は通常運用で大量に付くため、
 * 「人間が PR URL を含むメッセージに 👍 した」= 代理マージを意図したと判る場合だけ説明する。
 */
export function shouldExplainProxyMergeReject(input: {
  emojiName: string | null;
  reactorIsBot: boolean;
  content: string;
}): boolean {
  return (
    input.emojiName === "👍" && !input.reactorIsBot && parseGithubPrUrl(input.content) !== null
  );
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
  // 👍 以外(💡 capture・鮮度確認の ✏️🗑 等)は REST fetch せず無視する。
  if (reaction.emoji.name !== "👍") return;
  // ops 設定そのものが無い環境では「どのチャンネルの通知か」が判らず、操作の意図を特定できない
  // (= 通知先を決められない)。ADR-0030 D4 の対象外として静かに終える。
  if (ops === undefined) return;
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
    if (!decision.merge) {
      // ADR-0030 D5: 「👍 × 人間 × PR URL」= 代理マージの意図が明確なときだけ理由を返す。
      if (
        !shouldExplainProxyMergeReject({
          emojiName: r.emoji.name,
          reactorIsBot: reactor.bot,
          content: message.content,
        })
      ) {
        return;
      }
      const text = proxyMergeRejectMessage(decision.reason, ops.channel_id);
      if (text === null) return;
      const rejectLog = withCorrelation(deps.logger, "proxy-merge");
      // 設定不足の案内だけは連投を抑える(D4。ユーザーには直せないため)。
      if (
        text === PROXY_MERGE_OFF_MESSAGE &&
        !noticeAllowedOnce(
          deps.store,
          `user:${reactor.id}`,
          "feature-off-notice:proxy-merge",
          jstDayKey(new Date()),
        )
      ) {
        return;
      }
      rejectLog.info({ reason: decision.reason, userId: reactor.id }, "proxy merge rejected");
      await message.reply(text);
      return;
    }

    const log = withCorrelation(deps.logger, `${decision.repo}#${decision.number}`);
    if (gh === undefined) {
      // ops.yaml はあるが GitHub 認証が無い(ADR-0011 / ADR-0030 D4)。設定不足を本人に返す。
      log.warn({ userId: reactor.id }, "proxy merge is disabled (no GitHub auth)");
      if (
        noticeAllowedOnce(
          deps.store,
          `user:${reactor.id}`,
          "feature-off-notice:proxy-merge",
          jstDayKey(new Date()),
        )
      ) {
        await message.reply(PROXY_MERGE_OFF_MESSAGE);
      }
      return;
    }
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
  const m = /q-\d{4}-(?:[0-9a-z]{6}|\d{4})/.exec(text); // 新旧 ID 両対応(ADR-0026)。6文字を先に試す
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

/** 回答として受け取れなかったときの案内(ADR-0030 D5)。 */
export const GAP_ANSWER_REJECT_MESSAGE =
  "回答として受け取れませんでした。依頼メッセージ(bot が送った依頼)に直接返信してください。";

/** 依頼メッセージらしさ(q-ID 形の文字列を含むか)。他の webhook 通知と区別する。 */
export function looksLikeGapRequest(content: string): boolean {
  return /q-\d{4}-/.test(content);
}

/**
 * 未捕捉の返信に案内を返すべきか(ADR-0030 D5・純関数)。null = 無反応のまま。
 * 通常の会話の返信すべてに反応すると鬱陶しいので、次を全て満たす場合だけ返す:
 * - 返信先が bot / webhook の投稿(人間同士の返信には無反応)
 * - 返信先が自 bot の投稿ではない(voice 訂正フライホイールや /ask 回答への返信を横取りしない)
 * - no-question-id は「依頼らしい(q-ID 形を含む)のに読めない」ときだけ
 *   (extractor の PR 通知など、q-ID を持たない webhook への雑談返信には反応しない)
 */
export function gapAnswerRejectMessage(
  reason: string,
  referenced: { isBot: boolean; isSelf: boolean; content: string },
): string | null {
  if (!referenced.isBot || referenced.isSelf) return null;
  if (reason === "not-webhook-reference") return GAP_ANSWER_REJECT_MESSAGE;
  if (reason === "no-question-id" && looksLikeGapRequest(referenced.content)) {
    return GAP_ANSWER_REJECT_MESSAGE;
  }
  return null;
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
    if (!decision.capture) {
      // ADR-0030 D5: 依頼(bot/webhook 投稿)への返信のつもりで外した人にだけ案内する。
      const text = gapAnswerRejectMessage(decision.reason, {
        isBot: referenced.author?.bot ?? false,
        isSelf:
          referenced.author?.id !== undefined && referenced.author.id === message.client?.user?.id,
        content: referenced.content,
      });
      if (text === null) return;
      const rejectLog = withCorrelation(deps.logger, "gap-answer");
      rejectLog.info({ reason: decision.reason, authorId: message.author.id }, "gap answer missed");
      await ackReaction(message, "failed", rejectLog);
      await message.reply(text);
      return;
    }

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
    await ackReaction(message, "accepted", log); // 回答者へ「受け取った」ことを示す ack(§6.5 ④UI)
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
 * /stats(§1.4 KPI・利用状況 + 👍👎 集計)。応答は本人だけに見える ephemeral。
 * LLM 非使用の読み取りのみなので rate-limit・チャンネルゲートは掛けない(集計値は機微でない)。
 * 例外は handleButton と同型の封じ込め(catch → log + 未応答ならガード付き ephemeral 通知)。
 */
export async function handleStats(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  const log = withCorrelation(deps.logger, "stats");
  try {
    const summary = aggregateStats(deps.store.listQueries(), new Date());
    await interaction.reply({ content: formatStatsMessage(summary), ephemeral: true });
  } catch (err) {
    log.error({ err }, "stats command failed");
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "集計の取得に失敗しました。", ephemeral: true });
      } catch {
        // noop: 通知自体が失敗。ログ済み。
      }
    }
  }
}

/**
 * DM チャンネルキャッシュの事前ウォーム(discord.js 14.26.4 の DM リアクション欠落対策)。
 * 未キャッシュの DM チャンネルへのリアクションは、Action#getChannel がリアクション packet
 * (channel type / recipients を持たない)から DMChannel を組み立てられず、`Partials.Channel` を
 * 宣言していても MessageReactionAdd 自体が発火しない(ChannelManager#_add が null を返して
 * 無言 drop。最新 14.27.0 も同実装)。DM 送信元プロセスはチャンネルがキャッシュ済みのため動くが、
 * bot 再起動でキャッシュは空になり、過去に送った DM への応答だけが死ぬ(VM 実証 2026-07-18)。
 * 対策: members.yaml の全員分の DM チャンネルを起動時に createDM で開いてキャッシュへ載せる
 * (既存 DM チャンネルの取得のみで、メッセージ送信や相手への通知は発生しない)。
 * 対象導線: 鮮度確認 DM の 👍✏️🗑(§6.7)と capture レビュー DM の 👍(§6.4)。
 */
export async function warmDmChannels(
  client: Client,
  getMembers: MembersLoader,
  logger: Logger,
): Promise<void> {
  try {
    const { members } = await getMembers();
    let warmed = 0;
    let total = 0;
    let failed = 0;
    for (const member of members) {
      // primary + 別名 Discord の両方を温める(1 人で複数アカウント・ADR-0021 D2)。
      for (const discordId of [member.discord, ...(member.discord_alts ?? [])]) {
        total += 1;
        try {
          await client.users.createDM(discordId);
          warmed += 1;
        } catch (err) {
          failed += 1;
          // DM を開けない(相手の設定等)のは準正常系 — 該当者のリアクション応答だけが効かない。
          logger.warn(
            { err, github: member.github, discord: discordId },
            "DM チャンネルのウォームに失敗しました",
          );
        }
      }
    }
    // ADR-0030 D6: DM を開けない人が居ると DM 👍 の承認導線が死ぬため、起動ログで件数を見せる
    // (誰が開けないかは上の warn 行に github 名が出る)。
    logger.info(
      { warmed, total, dmWarmFailed: failed },
      "DM チャンネルをキャッシュしました(リアクション受信対策)",
    );
  } catch (err) {
    logger.warn({ err }, "DM チャンネルのウォームをスキップしました(members 読込失敗)");
  }
}

/**
 * voice-pipeline(PR-V3)用の Discord 送信 seam。channelId/messageId からスレッド返信、
 * userId から DM を送る(discord.js のグルー。パイプライン本体は discord.js に依存しない)。
 */
export function createClientMessenger(client: Client): {
  reply(channelId: string, messageId: string, content: string): Promise<void>;
  dm(userId: string, content: string): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
} {
  const fetchMessage = async (channelId: string, messageId: string): Promise<Message> => {
    const channel = await client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased()) {
      throw new Error(`channel ${channelId} is not text-based`);
    }
    return channel.messages.fetch(messageId);
  };
  return {
    async reply(channelId, messageId, content) {
      const message = await fetchMessage(channelId, messageId);
      await message.reply(content);
    },
    // ADR-0030 D1: パイプライン側の ack(⏳ / ⚠️)。失敗は ackReaction 側が warn で吸収する。
    async react(channelId, messageId, emoji) {
      const message = await fetchMessage(channelId, messageId);
      await message.react(emoji);
    },
    async dm(userId, content) {
      const user = await client.users.fetch(userId);
      await user.send(content);
    },
  };
}
