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
import {
  type ChannelGateInput,
  type ChannelsConfig,
  isChannelAllowed,
  type VoiceConfig,
} from "./config.js";
import type { BotStore } from "./db.js";
import { withCorrelation } from "./logger.js";
import { isoJst } from "./time.js";
import { gateInputFromChannel } from "./visibility.js";

/** pending_actions の type(§4.6)。消費側(PR-V3)と共有する。 */
export const VOICE_MEMO_ACTION_TYPE = "voice_memo";

/**
 * 受付キューの payload(消費側はこのスキーマで parse する。gap_answer の
 * gapAnswerPayloadSchema と同方針)。添付 URL は Discord CDN(期限付き)のため、
 * 消費が遅れて失効した場合は messageId から添付を再取得する。
 */
export const attachmentVoiceMemoPayloadSchema = z.object({
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
export type AttachmentVoiceMemoPayload = z.infer<typeof attachmentVoiceMemoPayloadSchema>;

/**
 * VC 録音入口(ADR-0020)の payload。書き手は vc-recorder.ts(finalize 成功時)、
 * 読み手は voice-pipeline(添付 DL の代わりに共有マウントのファイルを読む)。
 */
export const vcVoiceMemoPayloadSchema = z.object({
  source: z.literal("vc"),
  /** 冪等キー(PR ブランチ voice-memo/<meetingId>)。 */
  meetingId: z.string().min(1),
  /** recording.m4a の絶対パス(bot/sidecar 共有マウント上・ADR-0020 D4)。 */
  filePath: z.string().min(1),
  guildId: z.string(),
  channelId: z.string(),
  /** owner(最初の入室者。DM 先・起票者)。 */
  authorId: z.string(),
  /** 発話した参加者(sidecar の participant_ids)。members 写像で記事の people へ。 */
  participantIds: z.array(z.string()),
  recordedAtJst: z.string(),
});
export type VcVoiceMemoPayload = z.infer<typeof vcVoiceMemoPayloadSchema>;

/** 旧形式(source 無し = 添付)と VC 形の union(後方互換)。 */
export const voiceMemoPayloadSchema = z.union([
  attachmentVoiceMemoPayloadSchema,
  vcVoiceMemoPayloadSchema,
]);
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
  gate: ChannelGateInput;
  /** voice.yaml の channel_id(null = 機能 OFF)。 */
  voiceChannelId: string | null;
  /** §9.2(ADR-0018): 専用チャンネルは bot が見えること + permanent_exclude 外であること。 */
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
  if (input.gate.channelId !== input.voiceChannelId) {
    return { accept: false, reason: "other-channel" };
  }
  if (!isChannelAllowed(input.channels, input.gate)) {
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
      gate: gateInputFromChannel(message.channel, message.channelId),
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

// --- 訂正フライホイール(§6.4 ③-b L485 / PR-V4)---

/** pending_actions の type(訂正)。消費側は voice-pipeline.ts。 */
export const VOICE_CORRECTION_ACTION_TYPE = "voice_correction";

/** bot の「こう記録しました」返信の先頭マーカー(検知と対で使う)。 */
export const VOICE_REPLY_MARKER = "🎙️ こう記録しました";

/** 訂正キューの payload。branch は originalMessageId から決定的に復元する。 */
export const voiceCorrectionPayloadSchema = z.object({
  /** 元の音声メモの messageId(= voice-memo/<id> ブランチ)。 */
  originalMessageId: z.string(),
  /** bot 返信から抽出した PR 番号(open/merged 判定用)。 */
  prNumber: z.number().int().positive(),
  /** bot 返信から抽出した原本パス。 */
  transcriptPath: z.string().min(1),
  /** 訂正指示(返信本文)。 */
  correction: z.string().min(1),
  channelId: z.string(),
  /** 訂正メッセージの id(反映結果の返信先)。 */
  correctionMessageId: z.string(),
  correctorId: z.string(),
});
export type VoiceCorrectionPayload = z.infer<typeof voiceCorrectionPayloadSchema>;

/** bot 返信本文から PR 番号を抽出(無ければ null)。 */
export function extractPrNumber(content: string): number | null {
  const m = /\/pull\/(\d+)/.exec(content);
  return m === null ? null : Number(m[1]);
}

/** bot 返信本文から原本パスを抽出(無ければ null)。 */
export function extractTranscriptPath(content: string): string | null {
  const m = /`(interviews\/voice-memos\/[^`]+)`/.exec(content);
  return m === null ? null : (m[1] as string);
}

export interface VoiceCorrectionInput {
  /** 訂正者(人間のみ)。 */
  authorIsBot: boolean;
  /** 返信先が bot 自身の投稿か。 */
  referencedAuthorIsSelf: boolean;
  /** 返信先(bot の「こう記録しました」)の本文。 */
  referencedContent: string;
  /** 返信先がさらに返信していた元メッセージ(= 音声メモ本体)の id。 */
  referencedReferenceId: string | null;
  /** 訂正本文。 */
  content: string;
}

export type VoiceCorrectionDecision =
  | { capture: true; originalMessageId: string; prNumber: number; transcriptPath: string }
  | { capture: false; reason: string };

/**
 * 訂正返信のガード判定(純関数)。「bot の 🎙️ 記録返信への人間の返信」だけを拾う
 * (handleGapAnswer の webhook 判定と同じ思想。マーカー + 抽出可能な PR/パスで他の bot 返信を除外)。
 */
export function voiceCorrectionDecision(input: VoiceCorrectionInput): VoiceCorrectionDecision {
  if (input.authorIsBot) return { capture: false, reason: "bot-author" };
  if (!input.referencedAuthorIsSelf) return { capture: false, reason: "not-self-reference" };
  if (!input.referencedContent.startsWith(VOICE_REPLY_MARKER)) {
    return { capture: false, reason: "not-voice-reply" };
  }
  if (input.content.trim().length === 0) return { capture: false, reason: "empty-correction" };
  if (input.referencedReferenceId === null) {
    return { capture: false, reason: "no-original-reference" };
  }
  const prNumber = extractPrNumber(input.referencedContent);
  const transcriptPath = extractTranscriptPath(input.referencedContent);
  if (prNumber === null || transcriptPath === null) {
    return { capture: false, reason: "unparsable-reply" };
  }
  return {
    capture: true,
    originalMessageId: input.referencedReferenceId,
    prNumber,
    transcriptPath,
  };
}

/**
 * bot の「こう記録しました」返信への返信(訂正)を捕捉してキューへ積む(§6.4 L485 / PR-V4)。
 * 反映(fast モデル + PR ブランチ更新)は voice-pipeline が行う。
 * 例外は封じ込め(catch → log)。
 */
export async function handleVoiceCorrection(message: Message, deps: VoiceMemoDeps): Promise<void> {
  try {
    if (message.author.bot) return;
    const referenceId = message.reference?.messageId;
    if (referenceId === undefined) return;
    const botId = message.client.user?.id;
    if (botId === undefined) return;

    // 返信元(bot の記録返信)を取得。削除済みは throw → catch。
    const referenced = await message.fetchReference();
    const decision = voiceCorrectionDecision({
      authorIsBot: message.author.bot,
      referencedAuthorIsSelf: referenced.author.id === botId,
      referencedContent: referenced.content,
      referencedReferenceId: referenced.reference?.messageId ?? null,
      content: message.content,
    });
    if (!decision.capture) return;

    const log = withCorrelation(deps.logger, `voice-correction:${message.id}`);
    const payload: VoiceCorrectionPayload = {
      originalMessageId: decision.originalMessageId,
      prNumber: decision.prNumber,
      transcriptPath: decision.transcriptPath,
      correction: message.content,
      channelId: message.channelId,
      correctionMessageId: message.id,
      correctorId: message.author.id,
    };
    deps.store.queueAction({
      id: randomUUID(),
      type: VOICE_CORRECTION_ACTION_TYPE,
      queryId: null,
      payloadJson: JSON.stringify(payload),
      state: "pending",
      createdAt: isoJst(),
    });
    await message.react("✅"); // 受領 ack(反映完了は別途返信)
    log.info({ correctorId: message.author.id, pr: decision.prNumber }, "voice correction queued");
  } catch (err) {
    withCorrelation(deps.logger, "voice-correction").error(
      { err },
      "voice correction capture failed",
    );
  }
}
