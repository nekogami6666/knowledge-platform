/**
 * voice-memo 検知・受付(design.md §6.4 ③-b / ADR-0015 D5)。
 * #voice-memo 専用チャンネルへの音声添付・ボイスメッセージを検知し、pending_actions
 * (type "voice_memo")へ積んで ✅ で受領を示す。文字起こし・PR 作成は後続(PR-V2/V3)が
 * このキューを消費する — bot 再起動時も pending が残るためレジューム可能(gap_answer と同じ)。
 * 判定は純関数 voiceMemoDecision に抽出して単体テストする(CLAUDE.md §12.2)。
 */
import { randomUUID } from "node:crypto";
import { type Message, MessageFlags } from "discord.js";
import type { Logger } from "pino";
import { z } from "zod";
import { jstDayKey } from "./capture.js";
import { type ChannelsConfig, isChannelAllowed, type VoiceConfig } from "./config.js";
import type { BotStore } from "./db.js";
import { withCorrelation } from "./logger.js";
import { isoJst } from "./time.js";

/** pending_actions の type(§4.6)。消費側(PR-V3)と共有する。 */
export const VOICE_MEMO_ACTION_TYPE = "voice_memo";

/**
 * 受付キューの payload(消費側はこのスキーマで parse する。gap_answer の
 * gapAnswerPayloadSchema と同方針)。添付 URL は Discord CDN(期限付き)のため、
 * 消費が遅れて失効した場合は messageId から添付を再取得する。
 */
export const voiceMemoPayloadSchema = z.object({
  messageId: z.string(),
  channelId: z.string(),
  guildId: z.string(),
  authorId: z.string(),
  messageUrl: z.string(),
  attachmentUrl: z.string(),
  attachmentName: z.string().nullable(),
  contentType: z.string().nullable(),
  size: z.number().int().nonnegative(),
});
export type VoiceMemoPayload = z.infer<typeof voiceMemoPayloadSchema>;

// --- 純関数(単体テスト対象)---

/** 添付のメタデータ(discord.js の Attachment から必要な値だけを剥がした純粋データ)。 */
export interface VoiceAttachmentMeta {
  url: string;
  name: string | null;
  contentType: string | null;
  size: number;
}

export interface VoiceMemoDecisionInput {
  authorIsBot: boolean;
  /** guild メッセージか(DM は §6.4 で対象外)。 */
  inGuild: boolean;
  channelId: string;
  /** voice.yaml の channel_id(null = 機能 OFF)。 */
  voiceChannelId: string | null;
  /** §9.2 default-deny(専用チャンネルも channels.yaml の allow に入っていること)。 */
  channels: ChannelsConfig;
  attachments: VoiceAttachmentMeta[];
  /** ボイスメッセージ(MessageFlags.IsVoiceMessage)。 */
  isVoiceMessage: boolean;
  maxBytes: number;
}

export type VoiceMemoDecision =
  | { accept: true; attachment: VoiceAttachmentMeta }
  | { accept: false; reason: string; reply?: string };

/** 超過時の案内(ADR-0015 D6: チャンク分割はせず受け付けない)。 */
export function tooLargeMessage(maxBytes: number): string {
  const mb = Math.floor(maxBytes / (1024 * 1024));
  return `音声が大きすぎます(上限 ${mb}MB)。短く分割して投稿してください。`;
}

export const DAILY_LIMIT_MESSAGE = "音声メモの本日の上限に達しています。明日また投稿してください。";

/**
 * voice-memo 受付のガード判定(§6.4 ③-b・純関数)。専用チャンネル一致 / allowlist /
 * 人間 / guild / 音声添付あり / サイズ上限内 を全て満たすときのみ受け付ける。
 * 専用チャンネル内のテキスト投稿(音声なし)は雑談として無視する(reply しない)。
 */
export function voiceMemoDecision(input: VoiceMemoDecisionInput): VoiceMemoDecision {
  if (input.voiceChannelId === null) return { accept: false, reason: "disabled" };
  if (!input.inGuild) return { accept: false, reason: "not-guild" };
  if (input.channelId !== input.voiceChannelId) {
    return { accept: false, reason: "other-channel" };
  }
  if (!isChannelAllowed(input.channels, input.channelId)) {
    return { accept: false, reason: "channel-not-allowed" };
  }
  if (input.authorIsBot) return { accept: false, reason: "bot-author" };
  // 音声判定: contentType "audio/*" を優先。ボイスメッセージは audio/ogg 添付を持つが、
  // contentType 欠落時のフォールバックとして IsVoiceMessage フラグでも拾う。
  const audio =
    input.attachments.find((a) => a.contentType?.startsWith("audio/") ?? false) ??
    (input.isVoiceMessage ? input.attachments[0] : undefined);
  if (audio === undefined) return { accept: false, reason: "no-audio" };
  if (audio.size > input.maxBytes) {
    return { accept: false, reason: "too-large", reply: tooLargeMessage(input.maxBytes) };
  }
  return { accept: true, attachment: audio };
}

// --- 配線(合成テスト対象)---

export interface VoiceMemoDeps {
  logger: Logger;
  channels: ChannelsConfig;
  store: BotStore;
  /** voice.yaml(§6.4 ③-b)。未指定または channel_id が null なら機能 OFF。 */
  voice?: VoiceConfig;
  now?: () => Date;
}

/**
 * #voice-memo への投稿を検知して受付キューへ積む(§6.4 ③-b / ADR-0015 D5)。
 * MessageCreate は全メッセージに発火するため、機能 OFF と bot 投稿は最初に早期 return する
 * (bot 自身の ✅ 返信や案内で再発火してもここで止まる)。
 * 例外は封じ込め(catch → log)。ここで throw すると Gateway リスナが不安定になる。
 */
export async function handleVoiceMemo(message: Message, deps: VoiceMemoDeps): Promise<void> {
  try {
    const voice = deps.voice;
    if (voice === undefined || voice.channel_id === null) return; // 機能 OFF
    if (message.author.bot) return;

    const decision = voiceMemoDecision({
      authorIsBot: message.author.bot,
      inGuild: message.guildId !== null,
      channelId: message.channelId,
      voiceChannelId: voice.channel_id,
      channels: deps.channels,
      attachments: [...message.attachments.values()].map((a) => ({
        url: a.url,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
      })),
      isVoiceMessage: message.flags.has(MessageFlags.IsVoiceMessage),
      maxBytes: voice.max_attachment_bytes,
    });
    if (!decision.accept) {
      // サイズ超過だけは本人に理由を返す(D6)。それ以外(雑談・対象外)は静かに無視。
      if (decision.reply !== undefined) await message.reply(decision.reply);
      return;
    }

    const log = withCorrelation(deps.logger, `voice:${message.id}`);
    const now = deps.now?.() ?? new Date();

    // 乱用対策: user 日次上限(💡 capture と同じ流儀・§6.4)。専用チャンネル内なので reply で案内。
    const rate = deps.store.hitRateLimit(
      `user:${message.author.id}`,
      "voice_memo",
      jstDayKey(now),
      voice.daily_limit,
    );
    if (!rate.allowed) {
      await message.reply(DAILY_LIMIT_MESSAGE);
      return;
    }

    const payload: VoiceMemoPayload = {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? "",
      authorId: message.author.id,
      messageUrl: message.url,
      attachmentUrl: decision.attachment.url,
      attachmentName: decision.attachment.name,
      contentType: decision.attachment.contentType,
      size: decision.attachment.size,
    };
    deps.store.queueAction({
      id: randomUUID(),
      type: VOICE_MEMO_ACTION_TYPE,
      queryId: null,
      payloadJson: JSON.stringify(payload),
      state: "pending",
      createdAt: isoJst(),
    });
    await message.react("✅"); // 受領 ack(ADR-0015 D5。文字起こし完了は別途スレッド返信)
    log.info({ authorId: message.author.id, size: decision.attachment.size }, "voice memo queued");
  } catch (err) {
    withCorrelation(deps.logger, "voice-memo").error({ err }, "voice memo capture failed");
  }
}
