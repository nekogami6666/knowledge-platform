/**
 * 面談パネル(ADR-0028 interview セッションの Discord ネイティブ UI / design.md §6.6 ⑤-b)。
 * voice.yaml interview_panel_channel_id のチャンネル(VC 内蔵テキストチャット可)に bot が
 * 常設 embed を 1 枚維持し、[🎙 面談を開始] → UserSelectMenu(対象者)→ StringSelectMenu
 * (テーマ。候補は expertise.yaml 由来 + 「その他」自由入力モーダル)の選択式フローで
 * /interview start 相当を実行する。実行コアは interview-commands.ts と共有し、応答はすべて
 * ephemeral。パネルの所在は pending_actions type "interview_panel" の 1 行台帳
 * (state "pending" のまま保持・done にしない)で永続化し、再起動後も同じメッセージを編集する。
 * 判定・組み立ては純関数(buildPanelEmbed / panelComponents / parseInterviewCustomId)に
 * 抽出して単体テストする(CLAUDE.md §12.2)。
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type UserSelectMenuInteraction,
} from "discord.js";
import type { Logger } from "pino";
import { z } from "zod";
import type { BotStore } from "./db.js";
import {
  cancelInterviewCore,
  type InterviewCommandDeps,
  resolvePersonDisplay,
  startInterviewCore,
  statusInterviewCore,
} from "./interview-commands.js";
import {
  findActiveInterviewSession,
  type InterviewChunkBinding,
  type InterviewSessionPayload,
} from "./interview-session.js";
import type { InterviewTopicOption } from "./interview-topics.js";
import { withCorrelation } from "./logger.js";
import type { MembersLoader } from "./members.js";
import { isoJst } from "./time.js";

// --- customId(純関数で round-trip できる形に固定)---

/** 面談パネル系コンポーネントの customId prefix(discord.ts の分岐が使う)。 */
export const INTERVIEW_CUSTOM_ID_PREFIX = "interview:";

/** StringSelectMenu の「✏️ その他(自由入力)」選択肢の value。 */
export const CUSTOM_TOPIC_VALUE = "__custom__";

/** テーマ選択メニューの customId(`interview:topic:<personId>`)。 */
export function topicCustomId(personId: string): string {
  return `interview:topic:${personId}`;
}

/** 自由入力モーダルの customId(`interview:topicModal:<personId>`)。 */
export function topicModalCustomId(personId: string): string {
  return `interview:topicModal:${personId}`;
}

export type InterviewComponentId =
  | { kind: "open" }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "person" }
  | { kind: "topic"; personId: string }
  | { kind: "topicModal"; personId: string };

/** 面談パネル系 customId の解析(純関数)。対象外は null(他機能のボタン等)。 */
export function parseInterviewCustomId(customId: string): InterviewComponentId | null {
  if (customId === "interview:open") return { kind: "open" };
  if (customId === "interview:status") return { kind: "status" };
  if (customId === "interview:cancel") return { kind: "cancel" };
  if (customId === "interview:person") return { kind: "person" };
  const m = /^interview:(topic|topicModal):(.+)$/.exec(customId);
  if (m === null) return null;
  const personId = m[2] as string;
  return m[1] === "topic" ? { kind: "topic", personId } : { kind: "topicModal", personId };
}

// --- パネルの見た目(純関数)---

/**
 * 常設 embed(3 態: セッション無し / armed / recording)。now と TTL は文言
 * (経過分・自動キャンセルまでの残分)の計算に使う(statusInterviewCore と同じ規約)。
 */
export function buildPanelEmbed(
  session: { payload: InterviewSessionPayload; state: string } | null,
  now: Date,
  armTtlMinutes: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("🎙 ナレッジインタビュー")
    .setDescription(
      [
        "対象者とテーマを選ぶだけで面談(VC 録音 → 文字起こし PR)を始められます。",
        "「🎙 面談を開始」→ 対象者 → テーマの順に選択してください(テーマは自由入力も可)。",
        "録音は専用 VC で行われ、全員が退室すると文字起こしの PR が自動で作られます。",
      ].join("\n"),
    );
  if (session === null) {
    return embed.addFields({ name: "状態", value: "セッション無し(いつでも開始できます)" });
  }
  const p = session.payload;
  const elapsedMin = Math.max(0, Math.floor((now.getTime() - Date.parse(p.startedAtJst)) / 60_000));
  const value =
    session.state === "armed"
      ? [
          `armed(VC 入室待ち): ${p.person} × ${p.topic}`,
          `自動キャンセルまで: 残り ${Math.max(0, armTtlMinutes - elapsedMin)} 分`,
        ].join("\n")
      : [
          `recording(録音中): ${p.person} × ${p.topic}`,
          `チャンク: ${p.chunks.length} 本 / 経過: ${elapsedMin} 分`,
        ].join("\n");
  return embed.addFields({ name: "状態", value });
}

/** パネルのボタン行(開始 / 状況 / 中止)。 */
export function panelComponents(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("interview:open")
      .setLabel("🎙 面談を開始")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("interview:status")
      .setLabel("📋 状況")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("interview:cancel")
      .setLabel("✖ 中止")
      .setStyle(ButtonStyle.Danger),
  );
}

// --- パネル台帳(pending_actions type "interview_panel"・常設 1 行)---

/** PendingAction.type の値。state は "pending" のまま維持する(done にしない)。 */
export const INTERVIEW_PANEL_ACTION_TYPE = "interview_panel";

const panelLedgerPayloadSchema = z
  .object({ channelId: z.string().min(1), messageId: z.string().min(1) })
  .strict();

/** 台帳 1 行(パネルメッセージの所在)。壊れた行は無視する(次の ensurePanel が再投稿)。 */
export function findPanelLedger(
  store: BotStore,
): { id: string; channelId: string; messageId: string } | null {
  for (const action of store.listPendingActions(INTERVIEW_PANEL_ACTION_TYPE)) {
    if (action.state !== "pending") continue;
    try {
      const payload = panelLedgerPayloadSchema.parse(JSON.parse(action.payloadJson ?? ""));
      return { id: action.id, ...payload };
    } catch {}
  }
  return null;
}

// --- deps(discord.js Client への依存は narrow な seam に落としてテストする)---

/** パネルメッセージの送信/編集オプション(discord.js MessageCreateOptions のサブセット)。 */
export interface PanelMessageOptions {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export interface PanelMessage {
  edit(options: PanelMessageOptions): Promise<unknown>;
}

/** パネル設置先チャンネルの seam(VoiceChannel も isTextBased() = true で満たす)。 */
export interface PanelChannel {
  isTextBased(): boolean;
  messages: { fetch(messageId: string): Promise<PanelMessage> };
  send(options: PanelMessageOptions): Promise<{ id: string }>;
}

export interface InterviewPanelDeps {
  /** /interview コア(interview-commands.ts)の依存。store・TTL・now 等を共有する。 */
  commands: InterviewCommandDeps;
  /** パネル設置チャンネル(voice.yaml interview_panel_channel_id)。 */
  panelChannelId: string;
  /** チャンネル取得の seam(client.channels.fetch のグルー。見えない・無ければ null)。 */
  fetchChannel(channelId: string): Promise<PanelChannel | null>;
  /** person 解決(KB _meta/members.yaml の都度読み・ADR-0017 D3)。 */
  getMembers: MembersLoader;
  /** topic 候補(KB expertise/expertise.yaml の都度読み。失敗は [])。 */
  loadTopics(): Promise<InterviewTopicOption[]>;
}

/** 現在のセッション状態から送信/編集オプションを組み立てる。 */
function panelMessageOptions(deps: InterviewPanelDeps): PanelMessageOptions {
  const { store, armTtlMinutes } = deps.commands;
  const now = deps.commands.now();
  const session = findActiveInterviewSession(store, now, armTtlMinutes);
  return {
    embeds: [buildPanelEmbed(session, now, armTtlMinutes)],
    components: [panelComponents()],
  };
}

// --- パネルの設置と更新 ---

/**
 * 常設パネルを 1 枚に保つ: 台帳があれば messages.fetch で存在確認して edit、
 * 無い・fetch 失敗(削除済み等)なら新規投稿して台帳を upsert する。
 * ClientReady から呼ばれる(index.ts)。失敗は warn のみ(bot の主務を妨げない)。
 */
export async function ensurePanel(deps: InterviewPanelDeps): Promise<void> {
  const { store, logger } = deps.commands;
  const log = withCorrelation(logger, "interview-panel");
  try {
    const channel = await deps.fetchChannel(deps.panelChannelId);
    // VoiceChannel の内蔵テキストチャットも isTextBased() = true(discord.js v14)。
    if (channel === null || !channel.isTextBased()) {
      log.warn(
        { channelId: deps.panelChannelId },
        "パネル設置チャンネルが取得できない(またはテキスト非対応)ため設置をスキップします",
      );
      return;
    }
    const options = panelMessageOptions(deps);
    const ledger = findPanelLedger(store);
    if (ledger !== null && ledger.channelId === deps.panelChannelId) {
      try {
        const message = await channel.messages.fetch(ledger.messageId);
        await message.edit(options);
        return;
      } catch (err) {
        // メッセージが削除された等 — 常設 1 枚を保つため再投稿して台帳を差し替える。
        log.warn({ err, messageId: ledger.messageId }, "既存パネルを取得できないため再投稿します");
      }
    }
    const sent = await channel.send(options);
    const payloadJson = JSON.stringify({ channelId: deps.panelChannelId, messageId: sent.id });
    if (ledger !== null) {
      store.setActionPayload(ledger.id, payloadJson);
    } else {
      store.queueAction({
        id: deps.commands.makeId(),
        type: INTERVIEW_PANEL_ACTION_TYPE,
        queryId: null,
        payloadJson,
        state: "pending", // 常設台帳。done にしない(ensurePanel/refreshPanel が読み続ける)
        createdAt: isoJst(deps.commands.now()),
      });
    }
    log.info({ channelId: deps.panelChannelId, messageId: sent.id }, "面談パネルを設置しました");
  } catch (err) {
    log.warn({ err }, "面談パネルの設置に失敗しました");
  }
}

/**
 * パネル embed をセッションの現在状態へ更新する(セッション開始/中止・チャンク境界で呼ぶ)。
 * 失敗は warn のみ — 呼び手(録音処理・ハンドラ)を阻害しない。
 */
export async function refreshPanel(deps: InterviewPanelDeps): Promise<void> {
  const log = withCorrelation(deps.commands.logger, "interview-panel");
  try {
    const ledger = findPanelLedger(deps.commands.store);
    if (ledger === null) return; // 未設置(ensurePanel 前)— 次の ensurePanel が設置する
    const channel = await deps.fetchChannel(ledger.channelId);
    if (channel === null || !channel.isTextBased()) {
      log.warn({ channelId: ledger.channelId }, "パネルチャンネルが取得できず更新をスキップします");
      return;
    }
    const message = await channel.messages.fetch(ledger.messageId);
    await message.edit(panelMessageOptions(deps));
  } catch (err) {
    log.warn({ err }, "面談パネルの更新に失敗しました");
  }
}

/**
 * vc-recorder の InterviewChunkBinding をデコレートし、チャンク境界(claim/commit/drop/complete)
 * のたびにパネルを更新する(index.ts が配線)。refresh の失敗は warn のみで録音処理を阻害しない。
 */
export function bindingWithPanelRefresh(
  binding: InterviewChunkBinding,
  refresh: () => Promise<void>,
  logger: Pick<Logger, "warn">,
): InterviewChunkBinding {
  const kick = (): void => {
    void refresh().catch((err) => {
      logger.warn({ err }, "面談パネルの更新に失敗しました(録音処理は継続)");
    });
  };
  return {
    claimChunk(meetingId, recordedAtJst) {
      const claimed = binding.claimChunk(meetingId, recordedAtJst);
      kick();
      return claimed;
    },
    commitChunk(sessionActionId, chunk, participantIds) {
      binding.commitChunk(sessionActionId, chunk, participantIds);
      kick();
    },
    dropChunk(sessionActionId, meetingId) {
      binding.dropChunk(sessionActionId, meetingId);
      kick();
    },
    completeSession(sessionActionId) {
      binding.completeSession(sessionActionId);
      kick();
    },
    resumeTarget: () => binding.resumeTarget(),
  };
}

// --- コンポーネントハンドラ(すべて ephemeral・例外封じ込めは discord.ts handleButton と同型)---

/** 未 ack のときだけガード付きで ephemeral 通知する(handleButton の封じ込めと同型)。 */
async function replyGuarded(
  interaction: {
    replied: boolean;
    deferred: boolean;
    reply(options: { content: string; ephemeral: boolean }): Promise<unknown>;
  },
  content: string,
): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    try {
      await interaction.reply({ content, ephemeral: true });
    } catch {
      // noop: 通知自体が失敗。ログ済み。
    }
  }
}

/**
 * 開始フローの共通末尾: person 解決 → コミット1 の startInterviewCore → 応答 → パネル更新。
 * respond は select(update)と modal(reply)で ack 方法が違うため注入する。
 */
async function startFromPanel(
  deps: InterviewPanelDeps,
  input: { personId: string; topic: string; guildId: string | null; starterId: string },
  respond: (content: string) => Promise<unknown>,
): Promise<void> {
  // ADR-0018 D4 と同じ: guild 外(DM 等)からの interaction は明示拒否。
  if (input.guildId === null) {
    await respond("面談パネルはサーバー内でのみ利用できます。");
    return;
  }
  const person = resolvePersonDisplay(await deps.getMembers(), input.personId);
  const result = await startInterviewCore(
    {
      person,
      topic: input.topic,
      kitOption: null, // パネルは kit 自動発見のみ(interviewKitPath(person, topic))
      guildId: input.guildId,
      starterId: input.starterId,
    },
    deps.commands,
  );
  await respond(result.message);
  if (result.ok) void refreshPanel(deps);
}

/** パネルのボタン(open / status / cancel)。open は対象者の UserSelectMenu を ephemeral で出す。 */
export async function handleInterviewPanelButton(
  interaction: ButtonInteraction,
  deps: InterviewPanelDeps,
): Promise<void> {
  const parsed = parseInterviewCustomId(interaction.customId);
  if (parsed === null) return;
  const log = withCorrelation(deps.commands.logger, "interview-panel");
  try {
    if (parsed.kind === "open") {
      const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId("interview:person")
          .setPlaceholder("面談の対象者(誰に聞くか)を選択")
          .setMinValues(1)
          .setMaxValues(1),
      );
      await interaction.reply({
        content: "面談の対象者を選んでください。",
        components: [row],
        ephemeral: true,
      });
    } else if (parsed.kind === "status") {
      const result = statusInterviewCore(deps.commands);
      await interaction.reply({ content: result.message, ephemeral: true });
    } else if (parsed.kind === "cancel") {
      const result = await cancelInterviewCore(deps.commands);
      await interaction.reply({ content: result.message, ephemeral: true });
      if (result.ok) void refreshPanel(deps);
    }
  } catch (err) {
    log.error({ err }, "interview panel button failed");
    await replyGuarded(interaction, "操作の処理に失敗しました。");
  }
}

/** 対象者選択 → 同じ ephemeral をテーマ選択(候補 + 「その他」)に更新する。 */
export async function handleInterviewPersonSelect(
  interaction: UserSelectMenuInteraction,
  deps: InterviewPanelDeps,
): Promise<void> {
  if (parseInterviewCustomId(interaction.customId)?.kind !== "person") return;
  const log = withCorrelation(deps.commands.logger, "interview-panel");
  try {
    const personId = interaction.values[0];
    if (personId === undefined) return; // min 1 のため通常来ない
    const topics = await deps.loadTopics();
    const menu = new StringSelectMenuBuilder()
      .setCustomId(topicCustomId(personId))
      .setPlaceholder("テーマ(何を聞くか)を選択")
      .addOptions([
        { label: "✏️ その他(自由入力)", value: CUSTOM_TOPIC_VALUE },
        // Discord の選択肢は最大 25 件(候補は 24 件に切り詰め済み)・label は 100 字まで。
        ...topics.map((t) => ({ label: t.label.slice(0, 100), value: t.value })),
      ]);
    await interaction.update({
      content: `対象者: <@${personId}>\nテーマを選んでください(候補は expertise マップ由来)。`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  } catch (err) {
    log.error({ err }, "interview person select failed");
    await replyGuarded(interaction, "操作の処理に失敗しました。");
  }
}

/** テーマ選択 → 即開始。「その他」は自由入力モーダルを出す。 */
export async function handleInterviewTopicSelect(
  interaction: StringSelectMenuInteraction,
  deps: InterviewPanelDeps,
): Promise<void> {
  const parsed = parseInterviewCustomId(interaction.customId);
  if (parsed === null || parsed.kind !== "topic") return;
  const log = withCorrelation(deps.commands.logger, "interview-panel");
  try {
    const topic = interaction.values[0];
    if (topic === undefined) return;
    if (topic === CUSTOM_TOPIC_VALUE) {
      // ModalBuilder に置けるのは TextInput のみ(discord.js v14)— person は customId で運ぶ。
      const modal = new ModalBuilder()
        .setCustomId(topicModalCustomId(parsed.personId))
        .setTitle("面談テーマの入力")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("topic")
              .setLabel("テーマ(何を聞くか)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(100),
          ),
        );
      await interaction.showModal(modal);
      return;
    }
    await startFromPanel(
      deps,
      {
        personId: parsed.personId,
        topic,
        guildId: interaction.guildId,
        starterId: interaction.user.id,
      },
      // 選択メニューを畳んで結果文言に差し替える(同じ ephemeral を使い回す)。
      (content) => interaction.update({ content, components: [] }),
    );
  } catch (err) {
    log.error({ err }, "interview topic select failed");
    await replyGuarded(interaction, "操作の処理に失敗しました。");
  }
}

/** 「その他(自由入力)」モーダルの submit → 即開始。 */
export async function handleInterviewTopicModal(
  interaction: ModalSubmitInteraction,
  deps: InterviewPanelDeps,
): Promise<void> {
  const parsed = parseInterviewCustomId(interaction.customId);
  if (parsed === null || parsed.kind !== "topicModal") return;
  const log = withCorrelation(deps.commands.logger, "interview-panel");
  try {
    const topic = interaction.fields.getTextInputValue("topic").trim();
    if (topic.length === 0) {
      // TextInput は required だが、空白のみは通り得るため明示ガード。
      await interaction.reply({
        content: "テーマが空です。もう一度お試しください。",
        ephemeral: true,
      });
      return;
    }
    await startFromPanel(
      deps,
      {
        personId: parsed.personId,
        topic,
        guildId: interaction.guildId,
        starterId: interaction.user.id,
      },
      (content) => interaction.reply({ content, ephemeral: true }),
    );
  } catch (err) {
    log.error({ err }, "interview topic modal failed");
    await replyGuarded(interaction, "操作の処理に失敗しました。");
  }
}
