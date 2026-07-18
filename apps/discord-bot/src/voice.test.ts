import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { ChannelGateInput, ChannelsConfig, VoiceConfig } from "./config.js";
import type { BotStore, PendingAction } from "./db.js";
import {
  DAILY_LIMIT_MESSAGE,
  handleVoiceMemo,
  tooLargeMessage,
  VOICE_MEMO_ACTION_TYPE,
  type VoiceAttachmentMeta,
  type VoiceMemoDecisionInput,
  voiceMemoDecision,
  voiceMemoPayloadSchema,
} from "./voice.js";

const CHANNELS: ChannelsConfig = { permanent_exclude: [] };
const GATE = (over: Partial<ChannelGateInput> = {}): ChannelGateInput => ({
  channelId: "VC1",
  parentId: null,
  botCanView: true,
  ...over,
});
const VOICE: VoiceConfig = {
  channel_id: "VC1",
  max_attachment_bytes: 25 * 1024 * 1024,
  daily_limit: 3,
  vc_channel_id: null,
  max_recording_minutes: 15,
};

function audio(over: Partial<VoiceAttachmentMeta> = {}): VoiceAttachmentMeta {
  return {
    url: "https://cdn.discordapp.com/attachments/1/2/memo.ogg",
    name: "memo.ogg",
    contentType: "audio/ogg",
    size: 1024,
    ...over,
  };
}

function decisionInput(over: Partial<VoiceMemoDecisionInput> = {}): VoiceMemoDecisionInput {
  return {
    authorIsBot: false,
    inGuild: true,
    gate: GATE(),
    voiceChannelId: "VC1",
    channels: CHANNELS,
    attachments: [audio()],
    isVoiceMessage: false,
    maxBytes: VOICE.max_attachment_bytes,
    ...over,
  };
}

// --- voiceMemoDecision(純関数)------------------------------------------------

describe("voiceMemoDecision", () => {
  it("音声添付のある専用チャンネル投稿を受け付ける", () => {
    const d = voiceMemoDecision(decisionInput());
    expect(d).toEqual({ accept: true, attachment: audio() });
  });

  it("channel_id 未設定(機能 OFF)は無視する", () => {
    const d = voiceMemoDecision(decisionInput({ voiceChannelId: null }));
    expect(d).toMatchObject({ accept: false, reason: "disabled" });
  });

  it("DM(guild 外)は対象外(§6.4)", () => {
    const d = voiceMemoDecision(decisionInput({ inGuild: false }));
    expect(d).toMatchObject({ accept: false, reason: "not-guild" });
  });

  it("専用チャンネル以外の音声投稿は無視する", () => {
    const d = voiceMemoDecision(decisionInput({ gate: GATE({ channelId: "OTHER" }) }));
    expect(d).toMatchObject({ accept: false, reason: "other-channel" });
  });

  it("bot が専用チャンネルを見えないなら拒否(ADR-0018・安全側)", () => {
    const d = voiceMemoDecision(decisionInput({ gate: GATE({ botCanView: null }) }));
    expect(d).toMatchObject({ accept: false, reason: "channel-not-allowed" });
  });

  it("permanent_exclude されたチャンネルは拒否(§9.3)", () => {
    const d = voiceMemoDecision(decisionInput({ channels: { permanent_exclude: ["VC1"] } }));
    expect(d).toMatchObject({ accept: false, reason: "channel-not-allowed" });
  });

  it("bot の投稿は無視する", () => {
    const d = voiceMemoDecision(decisionInput({ authorIsBot: true }));
    expect(d).toMatchObject({ accept: false, reason: "bot-author" });
  });

  it("音声添付のないテキスト投稿は雑談として無視する(reply しない)", () => {
    const d = voiceMemoDecision(decisionInput({ attachments: [] }));
    expect(d).toMatchObject({ accept: false, reason: "no-audio" });
    expect((d as { reply?: string }).reply).toBeUndefined();
  });

  it("画像など音声以外の添付は無視し、混在時は音声だけを拾う", () => {
    const img = audio({ contentType: "image/png", name: "shot.png" });
    expect(voiceMemoDecision(decisionInput({ attachments: [img] }))).toMatchObject({
      accept: false,
      reason: "no-audio",
    });
    const d = voiceMemoDecision(decisionInput({ attachments: [img, audio()] }));
    expect(d).toEqual({ accept: true, attachment: audio() });
  });

  it("contentType 欠落でも IsVoiceMessage フラグがあれば先頭添付を拾う", () => {
    const bare = audio({ contentType: null });
    const d = voiceMemoDecision(decisionInput({ attachments: [bare], isVoiceMessage: true }));
    expect(d).toEqual({ accept: true, attachment: bare });
  });

  it("サイズ超過は理由の返信付きで拒否する(ADR-0015 D6)", () => {
    const big = audio({ size: VOICE.max_attachment_bytes + 1 });
    const d = voiceMemoDecision(decisionInput({ attachments: [big] }));
    expect(d).toMatchObject({
      accept: false,
      reason: "too-large",
      reply: tooLargeMessage(VOICE.max_attachment_bytes),
    });
  });
});

// --- handleVoiceMemo(合成)----------------------------------------------------

function fakeLogger(): { logger: Logger; errors: unknown[] } {
  const errors: unknown[] = [];
  const l = {
    child: () => l,
    error: (obj: unknown) => {
      errors.push(obj);
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  };
  return { logger: l as unknown as Logger, errors };
}

function fakeStore(opts: { rateAllowed?: boolean; queueThrows?: boolean } = {}): {
  store: BotStore;
  queued: PendingAction[];
} {
  const queued: PendingAction[] = [];
  const store = {
    hitRateLimit: vi.fn(() => ({ count: 1, allowed: opts.rateAllowed ?? true })),
    queueAction: vi.fn((a: PendingAction) => {
      if (opts.queueThrows === true) throw new Error("db closed");
      queued.push(a);
    }),
  };
  return { store: store as unknown as BotStore, queued };
}

function fakeMessage(
  over: {
    authorBot?: boolean;
    channelId?: string;
    guildId?: string | null;
    attachments?: VoiceAttachmentMeta[];
    isVoiceMessage?: boolean;
  } = {},
): { message: Message; replies: string[]; reactions: string[] } {
  const replies: string[] = [];
  const reactions: string[] = [];
  const atts = over.attachments ?? [audio()];
  const message = {
    id: "MSG1",
    author: { id: "U1", bot: over.authorBot ?? false },
    guildId: over.guildId !== undefined ? over.guildId : "G1",
    channelId: over.channelId ?? "VC1",
    channel: {
      isDMBased: () => false,
      parentId: null,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => true }),
    },
    url: "https://discord.com/channels/G1/VC1/MSG1",
    attachments: new Map(atts.map((a, i) => [String(i), a])),
    flags: { has: () => over.isVoiceMessage ?? false },
    reply: async (s: string) => {
      replies.push(s);
    },
    react: async (e: string) => {
      reactions.push(e);
    },
  };
  return { message: message as unknown as Message, replies, reactions };
}

describe("handleVoiceMemo", () => {
  it("受付時は voice_memo をキューに積み ✅ を付ける(payload はスキーマで parse 可能)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message, replies, reactions } = fakeMessage();
    await handleVoiceMemo(message, { logger, channels: CHANNELS, store, voice: VOICE });

    expect(reactions).toEqual(["✅"]);
    expect(replies).toEqual([]);
    expect(queued).toHaveLength(1);
    const action = queued[0] as PendingAction;
    expect(action.type).toBe(VOICE_MEMO_ACTION_TYPE);
    expect(action.state).toBe("pending");
    const payload = voiceMemoPayloadSchema.parse(JSON.parse(action.payloadJson ?? ""));
    if ("source" in payload) throw new Error("attachment payload expected");
    expect(payload.messageId).toBe("MSG1");
    expect(payload.authorId).toBe("U1");
    expect(payload.attachmentUrl).toBe(audio().url);
  });

  it("voice 未設定(機能 OFF)は store に触れない", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message, reactions } = fakeMessage();
    await handleVoiceMemo(message, { logger, channels: CHANNELS, store });
    expect(queued).toHaveLength(0);
    expect(reactions).toEqual([]);
    expect(store.hitRateLimit).not.toHaveBeenCalled();
  });

  it("bot 自身の投稿(✅ 後の返信等)では何もしない", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message } = fakeMessage({ authorBot: true });
    await handleVoiceMemo(message, { logger, channels: CHANNELS, store, voice: VOICE });
    expect(queued).toHaveLength(0);
  });

  it("サイズ超過は案内を返信しキューに積まない(D6)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const big = audio({ size: VOICE.max_attachment_bytes + 1 });
    const { message, replies, reactions } = fakeMessage({ attachments: [big] });
    await handleVoiceMemo(message, { logger, channels: CHANNELS, store, voice: VOICE });
    expect(replies).toEqual([tooLargeMessage(VOICE.max_attachment_bytes)]);
    expect(reactions).toEqual([]);
    expect(queued).toHaveLength(0);
  });

  it("日次上限超過は案内を返信しキューに積まない", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore({ rateAllowed: false });
    const { message, replies } = fakeMessage();
    await handleVoiceMemo(message, { logger, channels: CHANNELS, store, voice: VOICE });
    expect(replies).toEqual([DAILY_LIMIT_MESSAGE]);
    expect(queued).toHaveLength(0);
  });

  it("例外は封じ込めてログに残す(Gateway リスナを落とさない)", async () => {
    const { logger, errors } = fakeLogger();
    const { store } = fakeStore({ queueThrows: true });
    const { message } = fakeMessage();
    await expect(
      handleVoiceMemo(message, { logger, channels: CHANNELS, store, voice: VOICE }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

// --- 訂正フライホイール(PR-V4)------------------------------------------------

import {
  extractPrNumber,
  extractTranscriptPath,
  handleVoiceCorrection,
  VOICE_CORRECTION_ACTION_TYPE,
  VOICE_REPLY_MARKER,
  type VoiceCorrectionInput,
  voiceCorrectionDecision,
  voiceCorrectionPayloadSchema,
} from "./voice.js";

const BOT_REPLY = [
  `${VOICE_REPLY_MARKER}(冒頭): 分注ユニットの…`,
  "原本と記事の PR: https://github.com/org/knowledge-base/pull/7",
  "原本: `interviews/voice-memos/2026/2026-07-08-333333333333333333.md`",
  "訂正がある場合はこの返信にリプライしてください。",
].join("\n");

function correctionInput(over: Partial<VoiceCorrectionInput> = {}): VoiceCorrectionInput {
  return {
    authorIsBot: false,
    referencedAuthorIsSelf: true,
    referencedContent: BOT_REPLY,
    referencedReferenceId: "333333333333333333",
    content: "給脂は月イチではなく週イチです",
    ...over,
  };
}

describe("voiceCorrectionDecision", () => {
  it("bot の記録返信への人間の返信を訂正として受け付ける", () => {
    expect(voiceCorrectionDecision(correctionInput())).toEqual({
      capture: true,
      originalMessageId: "333333333333333333",
      prNumber: 7,
      transcriptPath: "interviews/voice-memos/2026/2026-07-08-333333333333333333.md",
    });
  });

  it("bot 自身の投稿・bot 以外への返信・マーカー無しは対象外", () => {
    expect(voiceCorrectionDecision(correctionInput({ authorIsBot: true }))).toMatchObject({
      capture: false,
    });
    expect(
      voiceCorrectionDecision(correctionInput({ referencedAuthorIsSelf: false })),
    ).toMatchObject({ capture: false, reason: "not-self-reference" });
    expect(
      voiceCorrectionDecision(correctionInput({ referencedContent: "ふつうの返信" })),
    ).toMatchObject({ capture: false, reason: "not-voice-reply" });
  });

  it("空の訂正・PR/パスを解析できない返信は対象外", () => {
    expect(voiceCorrectionDecision(correctionInput({ content: "  " }))).toMatchObject({
      capture: false,
      reason: "empty-correction",
    });
    expect(
      voiceCorrectionDecision(correctionInput({ referencedContent: `${VOICE_REPLY_MARKER} だけ` })),
    ).toMatchObject({ capture: false, reason: "unparsable-reply" });
  });
});

describe("extractPrNumber / extractTranscriptPath", () => {
  it("PR 番号と原本パスを抽出する", () => {
    expect(extractPrNumber(BOT_REPLY)).toBe(7);
    expect(extractTranscriptPath(BOT_REPLY)).toBe(
      "interviews/voice-memos/2026/2026-07-08-333333333333333333.md",
    );
    expect(extractPrNumber("no url")).toBeNull();
    expect(extractTranscriptPath("no path")).toBeNull();
  });
});

describe("handleVoiceCorrection", () => {
  function fakeCorrectionMessage(over: { refContent?: string; authorBot?: boolean } = {}): {
    message: Message;
    reactions: string[];
  } {
    const reactions: string[] = [];
    const referenced = {
      author: { id: "BOT" },
      content: over.refContent ?? BOT_REPLY,
      reference: { messageId: "333333333333333333" },
    };
    const message = {
      id: "CORR1",
      author: { id: "U1", bot: over.authorBot ?? false },
      channelId: "VC1",
      content: "給脂は週イチです",
      reference: { messageId: "REPLY1" },
      client: { user: { id: "BOT" } },
      fetchReference: async () => referenced,
      react: async (e: string) => {
        reactions.push(e);
      },
    };
    return { message: message as unknown as Message, reactions };
  }

  it("訂正を voice_correction としてキューに積み ✅ を付ける", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message, reactions } = fakeCorrectionMessage();
    await handleVoiceCorrection(message, { logger, channels: CHANNELS, store });
    expect(reactions).toEqual(["✅"]);
    expect(queued).toHaveLength(1);
    const action = queued[0] as PendingAction;
    expect(action.type).toBe(VOICE_CORRECTION_ACTION_TYPE);
    const payload = voiceCorrectionPayloadSchema.parse(JSON.parse(action.payloadJson ?? ""));
    expect(payload.prNumber).toBe(7);
    expect(payload.originalMessageId).toBe("333333333333333333");
    expect(payload.correction).toBe("給脂は週イチです");
  });

  it("マーカーの無い返信・bot の投稿では何もしない", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message } = fakeCorrectionMessage({ refContent: "ふつうの bot 返信" });
    await handleVoiceCorrection(message, { logger, channels: CHANNELS, store });
    const { message: botMsg } = fakeCorrectionMessage({ authorBot: true });
    await handleVoiceCorrection(botMsg, { logger, channels: CHANNELS, store });
    expect(queued).toHaveLength(0);
  });
});
