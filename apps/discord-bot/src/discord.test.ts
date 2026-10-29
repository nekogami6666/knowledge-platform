import type { GhClient, PrDetail } from "@stratum/gh-client";
import { LlmError } from "@stratum/llm";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  Message,
  MessageReaction,
  User,
} from "discord.js";
import {
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  MessageFlags,
  RESTJSONErrorCodes,
} from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  type AskResult,
  DEADLINE_SKIPPED_MESSAGE,
  ERROR_MESSAGE,
  INTERRUPTED_MESSAGE,
} from "./ask.js";
import {
  alreadySharedMessage,
  KEEP_DM_FAILED_MESSAGE,
  KEEP_DM_PARTIAL_MESSAGE,
  KEEP_DONE_MESSAGE,
  RECORD_NOT_FOUND_MESSAGE,
  SHARE_CANCELLED_MESSAGE,
  SHARE_DISCORD_CITED_MESSAGE,
  SHARE_FAILED_MESSAGE,
  SHARE_UNAVAILABLE_MESSAGE,
  shareConfirmMessage,
  shareDoneMessage,
} from "./ask-keep-share.js";
import { createAskLifecycle } from "./ask-lifecycle.js";
import { ASK_COMPLETION_LOG_MSG } from "./ask-metrics.js";
import { SerialQueue } from "./concurrency.js";
import type { ChannelGateInput, ChannelsConfig, OpsConfig } from "./config.js";
import type { BotStore, QueryRecord } from "./db.js";
import { createMemoryStore } from "./db.js";
import {
  ASK_ROLE_DENY_MESSAGE,
  askCommand,
  askHomeChannelMessage,
  BOT_INTENTS,
  type BotDeps,
  commandsToRegister,
  createBot,
  DENY_MESSAGE,
  DM_FALLBACK_NOTE,
  deliverAnswer,
  denyReason,
  extractQuestionId,
  feedbackButtons,
  GAP_ANSWER_REJECT_MESSAGE,
  gapAnswerDecision,
  gapAnswerRejectMessage,
  handleButton,
  handleGapAnswer,
  handleProxyMergeReaction,
  handleStats,
  INTERACTION_DEADLINE_MARGIN_MS,
  INTERACTION_TOKEN_MS,
  interactionLikelyExpired,
  interviewCommand,
  isExpiredInteractionError,
  looksLikeGapRequest,
  PROXY_MERGE_OFF_MESSAGE,
  parseFeedbackCustomId,
  parseGithubPrUrl,
  proxyMergeDecision,
  proxyMergeRejectMessage,
  RATE_LIMITS,
  SEND_FAILED_MESSAGE,
  SEND_PARTIAL_FAILED_MESSAGE,
  SHUTTING_DOWN_MESSAGE,
  shouldExplainProxyMergeReject,
  statsCommand,
  warmDmChannels,
  windowKey,
} from "./discord.js";
import { isoJst } from "./time.js";

/** discord.js を起動せずゲート配線(§9.2 / ADR-0018)の判定だけを検証する。 */
const channels = (over: Partial<ChannelsConfig> = {}): ChannelsConfig => ({
  permanent_exclude: [],
  ...over,
});
const gate = (over: Partial<ChannelGateInput> = {}): ChannelGateInput => ({
  channelId: "111",
  parentId: null,
  botCanView: true,
  ...over,
});

describe("denyReason(§9.2 / ADR-0018 の配線)", () => {
  it("bot が見えるチャンネルは null(許可 → onAsk へ進む)", () => {
    expect(denyReason(channels(), gate())).toBeNull();
  });

  it("不可視・判定不能は拒否メッセージ(安全側)", () => {
    expect(denyReason(channels(), gate({ botCanView: false }))).toBe(DENY_MESSAGE);
    expect(denyReason(channels(), gate({ botCanView: null }))).toBe(DENY_MESSAGE);
  });

  it("permanent_exclude は可視性より優先(拒否)", () => {
    expect(denyReason(channels({ permanent_exclude: ["111"] }), gate())).toBe(DENY_MESSAGE);
  });
});

describe("parseFeedbackCustomId", () => {
  it("fb:up:<id> / fb:down:<id> を解析する", () => {
    expect(parseFeedbackCustomId("fb:up:q1")).toEqual({ value: "up", queryId: "q1" });
    expect(parseFeedbackCustomId("fb:down:abc-123-def")).toEqual({
      value: "down",
      queryId: "abc-123-def",
    });
  });

  it("不正な customId は null", () => {
    for (const id of ["", "fb:up:", "fb:maybe:q1", "other:up:q1", "garbage"]) {
      expect(parseFeedbackCustomId(id)).toBeNull();
    }
  });
});

describe("feedbackButtons", () => {
  it("👍/👎 の2ボタンを queryId 付き customId で組む", () => {
    const json = feedbackButtons("q1").toJSON();
    const ids = json.components.map((c) => ("custom_id" in c ? c.custom_id : undefined));
    expect(ids).toEqual(["fb:up:q1", "fb:down:q1"]);
  });
});

describe("windowKey (10分バケット)", () => {
  it("同一10分窓は同じキー、跨ぐと別キー", () => {
    const base = 600_000 * 2_000_000; // バケット境界に揃える(固定バケットのため)
    expect(windowKey(base)).toBe(windowKey(base + 9 * 60 * 1000));
    expect(windowKey(base)).not.toBe(windowKey(base + 11 * 60 * 1000));
  });
});

/** discord.js を起動せず handleButton の配線・例外封じ込めを検証するための最小 fake 群。 */
function fakeLogger(): {
  logger: Logger;
  errors: unknown[];
  warns: unknown[];
  infos: { obj: Record<string, unknown>; msg: string | undefined }[];
} {
  const errors: unknown[] = [];
  const warns: unknown[] = [];
  const infos: { obj: Record<string, unknown>; msg: string | undefined }[] = [];
  const l = {
    child: () => l,
    error: (obj: unknown) => {
      errors.push(obj);
    },
    info: (obj: unknown, msg?: string) => {
      if (typeof obj === "object" && obj !== null) {
        infos.push({ obj: obj as Record<string, unknown>, msg });
      }
    },
    warn: (obj: unknown) => {
      warns.push(obj);
    },
    debug: () => {},
  };
  return { logger: l as unknown as Logger, errors, warns, infos };
}

function fakeStore(
  opts: { throwOnFeedback?: boolean; queryOwners?: Record<string, string> } = {},
): {
  store: BotStore;
  feedback: [string, string][];
  queued: unknown[];
} {
  const feedback: [string, string][] = [];
  const queued: unknown[] = [];
  const rateCounts = new Map<string, number>();
  const store = {
    // ADR-0034 D3: handleButton の本人照合が読む。未登載(undefined)は従来挙動 = 許可。
    getQuery: (id: string): QueryRecord | undefined => {
      const owner = opts.queryOwners?.[id];
      return owner === undefined ? undefined : ({ discordUserId: owner } as QueryRecord);
    },
    setFeedback: (id: string, value: "up" | "down") => {
      if (opts.throwOnFeedback) throw new Error("db locked");
      feedback.push([id, value]);
    },
    queueAction: (a: unknown) => {
      queued.push(a);
    },
    // 設定不足の案内は 1日1回に抑制される(ADR-0030 D4)ため、実挙動を再現する。
    hitRateLimit: (subject: string, kind: string, window: string, limit: number) => {
      const key = `${subject}|${kind}|${window}`;
      const count = (rateCounts.get(key) ?? 0) + 1;
      rateCounts.set(key, count);
      return { count, allowed: count <= limit };
    },
  };
  return { store: store as unknown as BotStore, feedback, queued };
}

function fakeButton(
  customId: string,
  userId = "u1",
): { interaction: ButtonInteraction; replies: unknown[] } {
  const replies: unknown[] = [];
  const interaction = {
    customId,
    replied: false,
    deferred: false,
    user: { id: userId },
    reply: async (o: unknown) => {
      replies.push(o);
    },
  };
  return { interaction: interaction as unknown as ButtonInteraction, replies };
}

describe("handleButton (例外封じ込め / 配線)", () => {
  const deps = (logger: Logger, store: BotStore): BotDeps => ({
    logger,
    channels: channels(),
    store,
  });

  it("👍 で setFeedback + 感謝 reply(queueAction は呼ばない)", async () => {
    const { logger } = fakeLogger();
    const { store, feedback, queued } = fakeStore();
    const { interaction, replies } = fakeButton("fb:up:q1");
    await handleButton(interaction, deps(logger, store));
    expect(feedback).toEqual([["q1", "up"]]);
    expect(queued).toHaveLength(0);
    expect(replies).toHaveLength(1);
  });

  it("👎 で setFeedback + queueAction(§6.2 step6)+ reply", async () => {
    const { logger } = fakeLogger();
    const { store, feedback, queued } = fakeStore();
    const { interaction } = fakeButton("fb:down:q2");
    await handleButton(interaction, deps(logger, store));
    expect(feedback).toEqual([["q2", "down"]]);
    expect(queued).toHaveLength(1);
  });

  it("不正 customId は何もしない(store/reply 不発)", async () => {
    const { logger } = fakeLogger();
    const { store, feedback } = fakeStore();
    const { interaction, replies } = fakeButton("garbage");
    await handleButton(interaction, deps(logger, store));
    expect(feedback).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it("store throw でも例外を外へ漏らさず log.error + ガード reply", async () => {
    const { logger, errors } = fakeLogger();
    const { store } = fakeStore({ throwOnFeedback: true });
    const { interaction, replies } = fakeButton("fb:up:q3");
    await expect(handleButton(interaction, deps(logger, store))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(replies).toHaveLength(1); // ガード付き ephemeral 通知
  });

  it("実行者本人以外の押下は拒否する(ADR-0034 D3・記録もキューも積まない)", async () => {
    const { logger } = fakeLogger();
    const { store, feedback, queued } = fakeStore({ queryOwners: { q1: "asker" } });
    const { interaction, replies } = fakeButton("fb:down:q1", "someone-else");
    await handleButton(interaction, deps(logger, store));
    expect(feedback).toHaveLength(0);
    expect(queued).toHaveLength(0);
    expect(replies).toEqual([
      {
        content: "この操作は /ask を実行した本人のみ行えます。",
        flags: MessageFlags.Ephemeral,
      },
    ]);
  });

  it("実行者本人の押下は従来どおり記録される(ADR-0034 D3)", async () => {
    const { logger } = fakeLogger();
    const { store, feedback } = fakeStore({ queryOwners: { q1: "u1" } });
    const { interaction, replies } = fakeButton("fb:up:q1", "u1");
    await handleButton(interaction, deps(logger, store));
    expect(feedback).toEqual([["q1", "up"]]);
    expect(replies).toHaveLength(1);
  });
});

describe("askCommand (/ask の登録定義)", () => {
  it("name=ask・必須の question オプションを持つ(REST 登録のペイロード)", () => {
    const json = askCommand.toJSON();
    expect(json.name).toBe("ask");
    const question = json.options?.find((o) => o.name === "question");
    expect(question).toBeDefined();
    expect(question && "required" in question && question.required).toBe(true);
  });
});

describe("interviewCommand / commandsToRegister (/interview の登録定義・ADR-0028 D5)", () => {
  it("name=interview・subcommands start(person/topic 必須・kit 任意)/ status / cancel", () => {
    const json = interviewCommand.toJSON();
    expect(json.name).toBe("interview");
    const subs = (json.options ?? []).map((o) => o.name);
    expect(subs).toEqual(["start", "status", "cancel"]);
    const start = json.options?.find((o) => o.name === "start");
    const opts =
      start !== undefined && "options" in start
        ? (start.options as { name: string; required?: boolean }[])
        : [];
    expect(opts.map((o) => [o.name, o.required ?? false])).toEqual([
      ["person", true],
      ["topic", true],
      ["kit", false],
    ]);
  });

  it("VC 録音が無効な環境(interview deps 未注入)では /interview を登録しない", () => {
    expect(commandsToRegister(false).map((c) => c.name)).toEqual(["ask", "stats"]);
    expect(commandsToRegister(true).map((c) => c.name)).toEqual(["ask", "stats", "interview"]);
  });
});

describe("BOT_INTENTS (§9.5 最小権限)", () => {
  it("Guilds + GuildMessages + リアクション(guild/DM)+ MessageContent(§6.3/§6.4/§6.5)", () => {
    // GuildMessages は gap 依頼への「返信」検知(PR-D2)、GuildMessageReactions は 👍 代理マージ + 💡 捕捉、
    // DirectMessageReactions は 💡 レビュー DM の 👍(PR-E1)、MessageContent(privileged)は webhook 本文の
    // PR URL / q-ID 読み取りに必要(§9.2 が Portal 有効化を想定)。
    expect([...BOT_INTENTS]).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates, // VC 録音の入退室検知(ADR-0020 D3)
    ]);
  });
});

describe("parseGithubPrUrl", () => {
  it("本文中の PR URL から repo と番号を取り出す", () => {
    expect(
      parseGithubPrUrl(
        "📥 抽出 PR を作成しました: https://github.com/org/knowledge-base/pull/12\n新規 3",
      ),
    ).toEqual({ repo: "org/knowledge-base", number: 12 });
  });
  it("PR URL が無い・別ホスト・issue URL は null", () => {
    expect(parseGithubPrUrl("no url here")).toBeNull();
    expect(parseGithubPrUrl("https://example.com/org/repo/pull/1")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/org/repo/issues/5")).toBeNull();
  });
});

const opsOn: OpsConfig = {
  channel_id: "OPS",
  kb_repo: "org/knowledge-base",
  ask_role_ids: [],
  home_channel_ids: [],
};

describe("proxyMergeDecision (§6.3 のガード判定)", () => {
  const base = {
    emojiName: "👍" as string | null,
    channelId: "OPS",
    messageWebhookId: "WH1" as string | null,
    reactorIsBot: false,
    content: "📥 抽出 PR を作成しました: https://github.com/org/knowledge-base/pull/12",
    ops: opsOn,
  };
  it("全ガードを満たすと merge(repo と番号を返す)", () => {
    expect(proxyMergeDecision(base)).toEqual({
      merge: true,
      repo: "org/knowledge-base",
      number: 12,
    });
  });
  it("ops 未設定(null)は機能 OFF", () => {
    expect(
      proxyMergeDecision({
        ...base,
        ops: { channel_id: null, kb_repo: null, ask_role_ids: [], home_channel_ids: [] },
      }),
    ).toEqual({
      merge: false,
      reason: "ops-config-off",
    });
  });
  it("👍 以外の絵文字は無視", () => {
    expect(proxyMergeDecision({ ...base, emojiName: "🎉" })).toEqual({
      merge: false,
      reason: "not-thumbsup",
    });
  });
  it("ops チャンネル以外は無視", () => {
    expect(proxyMergeDecision({ ...base, channelId: "OTHER" })).toEqual({
      merge: false,
      reason: "not-ops-channel",
    });
  });
  it("webhook でない通常メッセージは無視(人の雑談に反応しない)", () => {
    expect(proxyMergeDecision({ ...base, messageWebhookId: null })).toEqual({
      merge: false,
      reason: "not-webhook-message",
    });
  });
  it("bot のリアクションは無視", () => {
    expect(proxyMergeDecision({ ...base, reactorIsBot: true })).toEqual({
      merge: false,
      reason: "bot-reactor",
    });
  });
  it("kb_repo 以外のリポの PR URL は拒否", () => {
    expect(
      proxyMergeDecision({
        ...base,
        content: "https://github.com/org/other-repo/pull/9",
      }),
    ).toEqual({ merge: false, reason: "repo-not-allowed" });
  });
});

describe("proxyMergeDecision — DM ルート(§6.4 💡 capture)", () => {
  const dmBase = {
    emojiName: "👍" as string | null,
    channelId: "DM",
    messageWebhookId: null as string | null,
    reactorIsBot: false,
    content: "💡 PR: https://github.com/org/knowledge-base/pull/12",
    ops: opsOn,
    isDm: true,
    messageAuthorIsSelf: true,
  };
  it("自 bot の DM(capture のレビュー DM)への 👍 は merge(webhook 不要)", () => {
    expect(proxyMergeDecision(dmBase)).toEqual({
      merge: true,
      repo: "org/knowledge-base",
      number: 12,
    });
  });
  it("自 bot の投稿でない DM は無視(他人の DM に反応しない)", () => {
    expect(proxyMergeDecision({ ...dmBase, messageAuthorIsSelf: false })).toEqual({
      merge: false,
      reason: "not-self-dm",
    });
  });
  it("DM ルートはチャンネル一致を要求しない(DM 自体が信頼境界)", () => {
    expect(proxyMergeDecision({ ...dmBase, channelId: "ANYTHING" })).toEqual({
      merge: true,
      repo: "org/knowledge-base",
      number: 12,
    });
  });
  it("DM でも kb_repo 以外のリポは拒否", () => {
    expect(
      proxyMergeDecision({ ...dmBase, content: "https://github.com/org/other/pull/1" }),
    ).toEqual({ merge: false, reason: "repo-not-allowed" });
  });
});

describe("proxyMergeRejectMessage / shouldExplainProxyMergeReject (ADR-0030 D5)", () => {
  it("直せる拒否理由は日本語で返す。ops チャンネル外の 👍 には黙る(2026-10-07: 頼まれていない公開返信をしない)", () => {
    expect(proxyMergeRejectMessage("not-ops-channel", "OPS")).toBeNull();
    expect(proxyMergeRejectMessage("not-ops-channel", null)).toBeNull();
    expect(proxyMergeRejectMessage("not-webhook-message", "OPS")).toContain("bot の通知メッセージ");
    expect(proxyMergeRejectMessage("repo-not-allowed", "OPS")).toContain("対象外");
    expect(proxyMergeRejectMessage("ops-config-off", "OPS")).toBe(PROXY_MERGE_OFF_MESSAGE);
  });

  it("ノイズになる理由は null(通知しない)", () => {
    for (const reason of ["not-thumbsup", "bot-reactor", "no-pr-url", "not-self-dm"]) {
      expect(proxyMergeRejectMessage(reason, "OPS")).toBeNull();
    }
  });

  it("説明するのは「👍 × 人間 × PR URL」のときだけ(👍 は通常運用で大量に付く)", () => {
    const base = {
      emojiName: "👍" as string | null,
      reactorIsBot: false,
      content: "https://github.com/org/knowledge-base/pull/12",
    };
    expect(shouldExplainProxyMergeReject(base)).toBe(true);
    expect(shouldExplainProxyMergeReject({ ...base, emojiName: "🎉" })).toBe(false);
    expect(shouldExplainProxyMergeReject({ ...base, reactorIsBot: true })).toBe(false);
    expect(shouldExplainProxyMergeReject({ ...base, content: "いいね" })).toBe(false);
  });
});

describe("gapAnswerRejectMessage / looksLikeGapRequest (ADR-0030 D5)", () => {
  const webhookRef = { isBot: true, isSelf: false, content: "依頼です(q-2026-abc123)" };

  it("bot/webhook 投稿への返信が捕捉できなかったときだけ案内する", () => {
    expect(gapAnswerRejectMessage("not-webhook-reference", webhookRef)).toBe(
      GAP_ANSWER_REJECT_MESSAGE,
    );
    expect(gapAnswerRejectMessage("no-question-id", webhookRef)).toBe(GAP_ANSWER_REJECT_MESSAGE);
  });

  it("人間同士の返信・自 bot 投稿への返信・依頼でない webhook には反応しない", () => {
    expect(
      gapAnswerRejectMessage("not-webhook-reference", { ...webhookRef, isBot: false }),
    ).toBeNull();
    expect(gapAnswerRejectMessage("no-question-id", { ...webhookRef, isSelf: true })).toBeNull();
    expect(
      gapAnswerRejectMessage("no-question-id", { ...webhookRef, content: "📥 抽出 PR です" }),
    ).toBeNull();
    expect(gapAnswerRejectMessage("bot-author", webhookRef)).toBeNull();
  });

  it("looksLikeGapRequest は q-ID 形の有無で依頼らしさを見る", () => {
    expect(looksLikeGapRequest("(q-2026-0007)")).toBe(true);
    expect(looksLikeGapRequest("(q-2026-abc123)")).toBe(true);
    expect(looksLikeGapRequest("PR を作成しました")).toBe(false);
  });
});

/** handleProxyMergeReaction 用の最小 fake(webhook 通知メッセージ or 💡 DM + 人間のリアクション)。 */
function fakeReaction(
  over: {
    emoji?: string | null;
    channelId?: string;
    webhookId?: string | null;
    content?: string;
    userBot?: boolean;
    /** null で DM(§6.4)。既定は guild("G1")。 */
    guildId?: string | null;
    /** メッセージ投稿者 ID(DM ルートの自 bot 判定用)。 */
    authorId?: string;
    /** client.user.id(自 bot ID)。authorId と一致すれば messageAuthorIsSelf=true。 */
    selfId?: string;
  } = {},
): { reaction: MessageReaction; user: User; replies: string[] } {
  const replies: string[] = [];
  const message = {
    partial: false,
    channelId: over.channelId ?? "OPS",
    webhookId: over.webhookId !== undefined ? over.webhookId : "WH1",
    content:
      over.content ?? "📥 抽出 PR を作成しました: https://github.com/org/knowledge-base/pull/12",
    id: "MSG1",
    guildId: over.guildId !== undefined ? over.guildId : "G1",
    author: over.authorId !== undefined ? { id: over.authorId } : undefined,
    client: over.selfId !== undefined ? { user: { id: over.selfId } } : undefined,
    reply: async (s: string) => {
      replies.push(s);
    },
  };
  const reaction = {
    partial: false,
    emoji: { name: over.emoji !== undefined ? over.emoji : "👍" },
    message,
  };
  const user = { partial: false, bot: over.userBot ?? false, id: "U1" };
  return {
    reaction: reaction as unknown as MessageReaction,
    user: user as unknown as User,
    replies,
  };
}

function fakeGh(
  over: Partial<PrDetail> = {},
  opts: { throwOnMerge?: boolean } = {},
): { gh: GhClient; getPr: ReturnType<typeof vi.fn>; merge: ReturnType<typeof vi.fn> } {
  const detail: PrDetail = {
    number: 12,
    state: "open",
    merged: false,
    mergeableState: "clean",
    title: "Extract: a..b",
    url: "https://github.com/org/knowledge-base/pull/12",
    ...over,
  };
  const getPr = vi.fn(async () => detail);
  const merge = vi.fn(async () => {
    if (opts.throwOnMerge) throw new Error("boom");
  });
  return {
    gh: { getPullRequest: getPr, mergePullRequest: merge } as unknown as GhClient,
    getPr,
    merge,
  };
}

describe("handleProxyMergeReaction (§6.3 👍 代理マージ)", () => {
  const mkDeps = (logger: Logger, store: BotStore, gh?: GhClient, ops?: OpsConfig): BotDeps => ({
    logger,
    channels: channels(),
    store,
    ops: ops ?? opsOn,
    gh,
  });

  it("clean な PR は squash マージ + 監査行(pr_merge)+ ✅ reply", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { gh, merge } = fakeGh();
    const { reaction, user, replies } = fakeReaction();
    await handleProxyMergeReaction(reaction, user, mkDeps(logger, store, gh));
    expect(merge).toHaveBeenCalledWith({ repo: "org/knowledge-base", number: 12 });
    expect(queued).toHaveLength(1);
    expect((queued[0] as { type: string }).type).toBe("pr_merge");
    expect(replies[0]).toContain("✅");
  });

  it("gh 未設定(認証なし)はマージせず、設定不足を 1日1回だけ案内する(ADR-0030 D4)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { reaction, user, replies } = fakeReaction();
    const deps = mkDeps(logger, store, undefined);
    await handleProxyMergeReaction(reaction, user, deps);
    expect(queued).toHaveLength(0);
    expect(replies).toEqual([PROXY_MERGE_OFF_MESSAGE]);
    // 連投は抑制(同一ユーザー・同日)。
    const second = fakeReaction();
    await handleProxyMergeReaction(second.reaction, second.user, deps);
    expect(second.replies).toHaveLength(0);
  });

  it("💡 capture の DM(自 bot 投稿)への 👍 でマージ(§6.4 DM ルート)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { gh, merge } = fakeGh();
    const { reaction, user, replies } = fakeReaction({
      guildId: null, // DM
      webhookId: null, // DM は webhook ではない
      authorId: "BOT", // capture が送った DM(自 bot 投稿)
      selfId: "BOT",
      content: "💡 をナレッジ化する PR: https://github.com/org/knowledge-base/pull/12",
    });
    await handleProxyMergeReaction(reaction, user, mkDeps(logger, store, gh));
    expect(merge).toHaveBeenCalledWith({ repo: "org/knowledge-base", number: 12 });
    expect((queued[0] as { type: string }).type).toBe("pr_merge");
    expect(replies[0]).toContain("✅");
  });

  it("他人の DM(自 bot 投稿でない)への 👍 は gh に触れない", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh, getPr } = fakeGh();
    const { reaction, user } = fakeReaction({
      guildId: null,
      webhookId: null,
      authorId: "SOMEONE", // 自 bot ではない
      selfId: "BOT",
      content: "https://github.com/org/knowledge-base/pull/12",
    });
    await handleProxyMergeReaction(reaction, user, mkDeps(logger, store, gh));
    expect(getPr).not.toHaveBeenCalled();
  });

  it("マージ済みは冪等(merge を呼ばず案内 reply)", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh, merge } = fakeGh({ merged: true });
    const { reaction, user, replies } = fakeReaction();
    await handleProxyMergeReaction(reaction, user, mkDeps(logger, store, gh));
    expect(merge).not.toHaveBeenCalled();
    expect(replies[0]).toContain("既に");
  });

  it("mergeable_state が clean でなければマージしない(ADR-0004 D2)", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh, merge } = fakeGh({ mergeableState: "unstable" });
    const { reaction, user, replies } = fakeReaction();
    await handleProxyMergeReaction(reaction, user, mkDeps(logger, store, gh));
    expect(merge).not.toHaveBeenCalled();
    expect(replies[0]).toContain("⛔");
  });

  it("👍 以外・対象外メッセージは gh に触れない", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh, getPr } = fakeGh();
    for (const over of [{ emoji: "🎉" }, { webhookId: null }, { channelId: "OTHER" }]) {
      const { reaction, user } = fakeReaction(over);
      await handleProxyMergeReaction(reaction, user, mkDeps(logger, store, gh));
    }
    expect(getPr).not.toHaveBeenCalled();
  });

  it("merge throw でも例外を外へ漏らさず log.error + ❌ reply 試行", async () => {
    const { logger, errors } = fakeLogger();
    const { store } = fakeStore();
    const { gh } = fakeGh({}, { throwOnMerge: true });
    const { reaction, user, replies } = fakeReaction();
    await expect(
      handleProxyMergeReaction(reaction, user, mkDeps(logger, store, gh)),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(replies.some((r) => r.includes("❌"))).toBe(true);
  });
});

describe("extractQuestionId", () => {
  it("依頼本文の (q-YYYY-NNNN) を取り出す", () => {
    expect(extractQuestionId("山田 さんが「湿度」を探していました。\n(q-2026-0007)")).toBe(
      "q-2026-0007",
    );
  });
  it("q-ID が無い・形式違いは null", () => {
    expect(extractQuestionId("ただの雑談です")).toBeNull();
    expect(extractQuestionId("q-26-7 は形式違い")).toBeNull();
  });
});

describe("gapAnswerDecision (§6.5 ④UI のガード判定)", () => {
  const base = {
    authorIsBot: false,
    referencedWebhookId: "WH1" as string | null,
    referencedContent: "山田 さんが「湿度」を探していました。\n(q-2026-0007)",
  };
  it("人間 × webhook 依頼 × q-ID → capture", () => {
    expect(gapAnswerDecision(base)).toEqual({ capture: true, questionId: "q-2026-0007" });
  });
  it("bot の返信は無視", () => {
    expect(gapAnswerDecision({ ...base, authorIsBot: true })).toEqual({
      capture: false,
      reason: "bot-author",
    });
  });
  it("返信元が webhook でない(通常メッセージ)は無視", () => {
    expect(gapAnswerDecision({ ...base, referencedWebhookId: null })).toEqual({
      capture: false,
      reason: "not-webhook-reference",
    });
  });
  it("返信元に q-ID が無ければ無視(他の webhook 通知に反応しない)", () => {
    expect(
      gapAnswerDecision({
        ...base,
        referencedContent: "📥 抽出 PR: https://github.com/org/knowledge-base/pull/3",
      }),
    ).toEqual({ capture: false, reason: "no-question-id" });
  });
});

/** handleGapAnswer 用の最小 fake(gap 依頼 webhook への返信メッセージ)。 */
function fakeMessage(
  over: {
    authorBot?: boolean;
    isReply?: boolean;
    referencedWebhookId?: string | null;
    referencedContent?: string;
    content?: string;
    fetchThrows?: boolean;
    reactThrows?: boolean;
    /** 返信元の投稿者(既定 = webhook 相当の bot)。 */
    referencedAuthorBot?: boolean;
    /** 返信元が自 bot の投稿か(voice 訂正・/ask 回答への返信を区別する)。 */
    referencedAuthorId?: string;
    /** 返信が投稿されたチャンネル(ホームチャンネルの判定用)。スレッドなら parentId。 */
    channelId?: string;
    parentId?: string | null;
  } = {},
): { message: Message; reacted: string[]; replies: string[] } {
  const reacted: string[] = [];
  const replies: string[] = [];
  const referenced = {
    webhookId: over.referencedWebhookId !== undefined ? over.referencedWebhookId : "WH1",
    content: over.referencedContent ?? "山田 さんが「湿度」を探していました。\n(q-2026-0007)",
    author: { bot: over.referencedAuthorBot ?? true, id: over.referencedAuthorId ?? "WEBHOOK" },
  };
  const message = {
    author: { bot: over.authorBot ?? false, id: "U1" },
    reference: over.isReply === false ? null : { messageId: "REQ1" },
    content: over.content ?? "湿度が高いと Y 軸が脱調します。",
    url: "https://discord.com/channels/1/2/3",
    channelId: over.channelId ?? "CH1",
    channel: { parentId: over.parentId ?? null },
    client: { user: { id: "BOT" } },
    fetchReference: async () => {
      if (over.fetchThrows) throw new Error("unknown message");
      return referenced;
    },
    react: async (emoji: string) => {
      if (over.reactThrows) throw new Error("missing permissions");
      reacted.push(emoji);
    },
    reply: async (content: string) => {
      replies.push(content);
    },
  };
  return { message: message as unknown as Message, reacted, replies };
}

describe("handleGapAnswer (§6.5 ④UI 捕捉 / 例外封じ込め)", () => {
  const deps = (logger: Logger, store: BotStore): BotDeps => ({
    logger,
    channels: channels(),
    store,
  });

  it("依頼への人間の返信 → gap_answer をキュー(payload)+ ✅ ack", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message, reacted } = fakeMessage();
    await handleGapAnswer(message, deps(logger, store));
    expect(queued).toHaveLength(1);
    const a = queued[0] as { type: string; state: string; payloadJson: string };
    expect(a.type).toBe("gap_answer");
    expect(a.state).toBe("pending");
    expect(JSON.parse(a.payloadJson)).toMatchObject({
      questionId: "q-2026-0007",
      authorId: "U1",
      content: "湿度が高いと Y 軸が脱調します。",
      messageUrl: "https://discord.com/channels/1/2/3",
    });
    expect(reacted).toEqual(["✅"]);
  });

  it("返信でないメッセージは fetch せず何もしない", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message, reacted } = fakeMessage({ isReply: false });
    await handleGapAnswer(message, deps(logger, store));
    expect(queued).toHaveLength(0);
    expect(reacted).toHaveLength(0);
  });

  it("bot の返信は無視(webhook 同士の連鎖に反応しない)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message } = fakeMessage({ authorBot: true });
    await handleGapAnswer(message, deps(logger, store));
    expect(queued).toHaveLength(0);
  });

  it("返信元が webhook でない / q-ID が無い → キューしない", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    for (const over of [{ referencedWebhookId: null }, { referencedContent: "q-ID なし" }]) {
      const { message } = fakeMessage(over);
      await handleGapAnswer(message, deps(logger, store));
    }
    expect(queued).toHaveLength(0);
  });

  it("bot 投稿への返信を捕捉できなかったら ⚠️ + 案内を返す(ADR-0030 D5)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    // (a) 依頼ではないメッセージ(bot の非 webhook 投稿)に返信した
    const a = fakeMessage({ referencedWebhookId: null });
    await handleGapAnswer(a.message, deps(logger, store));
    // (b) 依頼らしい(q-ID 形)のに読めない
    const b = fakeMessage({ referencedContent: "依頼です(q-2026-XXXX)" });
    await handleGapAnswer(b.message, deps(logger, store));
    expect(queued).toHaveLength(0);
    expect(a.reacted).toEqual(["⚠️"]);
    expect(a.replies).toEqual([GAP_ANSWER_REJECT_MESSAGE]);
    expect(b.replies).toEqual([GAP_ANSWER_REJECT_MESSAGE]);
  });

  it("他の bot の通常投稿(依頼らしくない)への返信には無反応(2026-10-07: OpenClaw 等との会話に割り込まない)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const c = fakeMessage({ referencedWebhookId: null, referencedContent: "今日の天気は晴れです" });
    await handleGapAnswer(c.message, deps(logger, store));
    expect(queued).toHaveLength(0);
    expect(c.replies).toEqual([]);
    expect(c.reacted).toEqual([]);
  });

  it("ホームチャンネル外では案内もリアクションもしない。ホーム内(スレッドは親で判定)では案内する", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const homeDeps: BotDeps = {
      ...deps(logger, store),
      ops: { channel_id: null, kb_repo: null, ask_role_ids: [], home_channel_ids: ["HOME"] },
    };
    const outside = fakeMessage({ referencedWebhookId: null, channelId: "OTHER" });
    await handleGapAnswer(outside.message, homeDeps);
    expect(outside.replies).toEqual([]);
    expect(outside.reacted).toEqual([]);
    const inThread = fakeMessage({ referencedWebhookId: null, channelId: "T1", parentId: "HOME" });
    await handleGapAnswer(inThread.message, homeDeps);
    expect(inThread.replies).toEqual([GAP_ANSWER_REJECT_MESSAGE]);
  });

  it("正しい依頼への返信はホームチャンネル外でも受け付ける(依頼の投稿先で回答できるように)", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message, reacted } = fakeMessage({ channelId: "OTHER" });
    await handleGapAnswer(message, {
      ...deps(logger, store),
      ops: { channel_id: null, kb_repo: null, ask_role_ids: [], home_channel_ids: ["HOME"] },
    });
    expect(queued).toHaveLength(1);
    expect(reacted).toEqual(["✅"]);
  });

  it("人間同士の返信・自 bot の投稿への返信・q-ID と無関係な webhook には無反応", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const cases = [
      // 人間への返信(会話)
      fakeMessage({ referencedWebhookId: null, referencedAuthorBot: false }),
      // 自 bot の投稿への返信(voice 訂正フライホイール等)
      fakeMessage({ referencedWebhookId: null, referencedAuthorId: "BOT" }),
      // q-ID を持たない webhook 通知(extractor の PR 通知など)への雑談返信
      fakeMessage({ referencedContent: "📥 抽出 PR を作成しました" }),
    ];
    for (const c of cases) await handleGapAnswer(c.message, deps(logger, store));
    expect(cases.flatMap((c) => c.replies)).toEqual([]);
    expect(cases.flatMap((c) => c.reacted)).toEqual([]);
  });

  it("fetchReference が throw(削除済み等)でも例外を漏らさず log.error", async () => {
    const { logger, errors } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message } = fakeMessage({ fetchThrows: true });
    await expect(handleGapAnswer(message, deps(logger, store))).resolves.toBeUndefined();
    expect(queued).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("react が throw でも封じ込め(キューは積まれ、例外は漏れない)", async () => {
    const { logger, errors } = fakeLogger();
    const { store, queued } = fakeStore();
    const { message } = fakeMessage({ reactThrows: true });
    await expect(handleGapAnswer(message, deps(logger, store))).resolves.toBeUndefined();
    expect(queued).toHaveLength(1);
    // ack の失敗は本処理を落とさない(ADR-0030 D1)。warn に落ちて error にはならない。
    expect(errors).toHaveLength(0);
  });
});

describe("warmDmChannels(discord.js DM リアクション欠落対策)", () => {
  const mkLogger = () => {
    const warns: unknown[] = [];
    const infos: unknown[] = [];
    const l = {
      child: () => l,
      warn: (o: unknown) => warns.push(o),
      info: (o: unknown) => infos.push(o),
      error: () => {},
      debug: () => {},
    };
    return { logger: l as unknown as Logger, warns, infos };
  };

  it("members 全員分の createDM を呼び、失敗者は warn してスキップ(全体は続行)", async () => {
    const opened: string[] = [];
    const client = {
      users: {
        createDM: async (id: string) => {
          if (id === "U2") throw new Error("cannot open");
          opened.push(id);
        },
      },
    } as never;
    const { logger, warns, infos } = mkLogger();
    await warmDmChannels(
      client,
      async () => ({
        members: [
          { github: "a", discord: "U1" },
          { github: "b", discord: "U2" },
          { github: "c", discord: "U3" },
        ],
      }),
      logger,
    );
    expect(opened).toEqual(["U1", "U3"]);
    expect(warns).toHaveLength(1);
    // ADR-0030 D6: DM を開けない人数を起動ログに出す(DM 👍 の承認導線が死ぬため)。
    expect(infos.at(-1)).toMatchObject({ warmed: 2, total: 3, dmWarmFailed: 1 });
  });

  it("members 読込失敗は warn のみで throw しない", async () => {
    const { logger, warns } = mkLogger();
    await warmDmChannels(
      {} as never,
      async () => {
        throw new Error("kb clone missing");
      },
      logger,
    );
    expect(warns).toHaveLength(1);
  });
});

describe("handleStats / statsCommand (§1.4 KPI)", () => {
  const statsDeps = (logger: Logger, store: BotStore): BotDeps => ({
    logger,
    channels: channels(),
    store,
  });

  function fakeChatInput(): {
    interaction: ChatInputCommandInteraction;
    replies: { content: string; ephemeral?: boolean }[];
  } {
    const replies: { content: string; ephemeral?: boolean }[] = [];
    const interaction = {
      replied: false,
      deferred: false,
      reply: async (o: { content: string; ephemeral?: boolean }) => {
        replies.push(o);
      },
    };
    return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
  }

  const sampleQ = {
    id: "1",
    correlationId: "c",
    discordUserId: "u",
    discordChannelId: "ch",
    threadId: null,
    question: "q?",
    answer: null,
    sourcesJson: null,
    answerStatus: "answered" as const,
    feedback: "up" as const,
    inputTokens: null,
    outputTokens: null,
    elapsedMs: null,
    createdAt: isoJst(),
  };

  it("statsCommand は name=stats", () => {
    expect(statsCommand.toJSON().name).toBe("stats");
  });

  it("集計を ephemeral で返す(本人だけに表示)", async () => {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    store.recordQuery(sampleQ);
    const { interaction, replies } = fakeChatInput();
    await handleStats(interaction, statsDeps(logger, store));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.ephemeral).toBe(true);
    expect(replies[0]?.content).toContain("📊");
  });

  it("listQueries が throw しても封じ込め、ガード付き ephemeral 通知", async () => {
    const { logger, errors } = fakeLogger();
    const store = {
      listQueries: () => {
        throw new Error("db locked");
      },
    } as unknown as BotStore;
    const { interaction, replies } = fakeChatInput();
    await expect(handleStats(interaction, statsDeps(logger, store))).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(replies).toHaveLength(1); // ガード付き通知
  });
});

describe("InteractionCreate の面談パネル分岐(ADR-0028 UI の配線)", () => {
  function fakePanelInteraction(customId: string): {
    interaction: Interaction;
    replies: { content?: string; ephemeral?: boolean }[];
  } {
    const replies: { content?: string; ephemeral?: boolean }[] = [];
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      replied: false,
      deferred: false,
      reply: async (o: { content?: string; ephemeral?: boolean }) => {
        replies.push(o);
        (interaction as { replied: boolean }).replied = true;
      },
    };
    return { interaction: interaction as unknown as Interaction, replies };
  }

  it("interviewPanel 未注入(パネル無効)なら interview: ボタンに無反応", async () => {
    const { logger } = fakeLogger();
    const client = createBot({ logger, channels: channels(), store: createMemoryStore() });
    const { interaction, replies } = fakePanelInteraction("interview:status");
    client.emit(Events.InteractionCreate, interaction);
    await new Promise((resolve) => setImmediate(resolve));
    expect(replies).toHaveLength(0);
    await client.destroy();
  });

  it("interviewPanel 注入時は interview: ボタンがパネルハンドラへ配線される", async () => {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    const client = createBot({
      logger,
      channels: channels(),
      store,
      interviewPanel: {
        commands: {
          store,
          voiceVcChannelId: "VC1",
          armTtlMinutes: 120,
          maxRecordingMinutes: 15,
          hasActiveRecording: () => false,
          abortActiveRecording: async () => {},
          makeId: () => "id-1",
          now: () => new Date(),
          logger,
        },
        panelChannelId: "PANEL",
        fetchChannel: async () => null,
        getMembers: async () => ({ members: [] }),
        loadTopics: async () => [],
      },
    });
    const { interaction, replies } = fakePanelInteraction("interview:status");
    client.emit(Events.InteractionCreate, interaction);
    await new Promise((resolve) => setImmediate(resolve));
    expect(replies[0]?.content).toBe("進行中のセッションはありません。");
    expect(replies[0]?.ephemeral).toBe(true);
    await client.destroy();
  });
});

describe("deliverAnswer (§6.2 分割配送)", () => {
  type Sent = { via: "editReply" | "followUp"; content: string; components: number };

  /** 配列に積む fake seam。failOn で n 回目(1 始まり)の送信だけを失敗させる。 */
  function fakeDelivery(failOn: number[] = []): {
    delivery: Parameters<typeof deliverAnswer>[0];
    sends: Sent[];
  } {
    const sends: Sent[] = [];
    let calls = 0;
    const record = (via: Sent["via"]) => {
      return async (m: { content: string; components: unknown[] }) => {
        calls += 1;
        if (failOn.includes(calls)) throw new Error(`send failure #${calls}`);
        sends.push({ via, content: m.content, components: m.components.length });
      };
    };
    return { delivery: { editReply: record("editReply"), followUp: record("followUp") }, sends };
  }

  const buttons = [feedbackButtons("q1")];

  it("単一チャンクは editReply 1 回で components 付き", async () => {
    const { delivery, sends } = fakeDelivery();
    const outcome = await deliverAnswer(delivery, ["回答"], buttons);
    expect(outcome).toEqual({ sentChunks: 1, fallbackChunks: 0 });
    expect(sends).toEqual([{ via: "editReply", content: "回答", components: 1 }]);
  });

  it("3 チャンクは editReply → followUp → followUp の順で、components は末尾のみ", async () => {
    const { delivery, sends } = fakeDelivery();
    const outcome = await deliverAnswer(delivery, ["a", "b", "c"], buttons);
    expect(outcome).toEqual({ sentChunks: 3, fallbackChunks: 0 });
    expect(sends).toEqual([
      { via: "editReply", content: "a", components: 0 },
      { via: "followUp", content: "b", components: 0 },
      { via: "followUp", content: "c", components: 1 },
    ]);
  });

  it("先頭 editReply の失敗は editReply で SEND_FAILED を通知(何も配送していないので安全)", async () => {
    const { delivery, sends } = fakeDelivery([1]);
    const outcome = await deliverAnswer(delivery, ["a", "b"], buttons);
    expect(outcome.sentChunks).toBe(0);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.noticeError).toBeUndefined();
    expect(sends).toEqual([{ via: "editReply", content: SEND_FAILED_MESSAGE, components: 0 }]);
  });

  it("途中の followUp 失敗は followUp で部分失敗を通知し、editReply は使わない(上書き防止)+ components 付き", async () => {
    const { delivery, sends } = fakeDelivery([3]); // 3 チャンク中 2 つ目の followUp で失敗
    const outcome = await deliverAnswer(delivery, ["a", "b", "c"], buttons);
    expect(outcome.sentChunks).toBe(2);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(sends.filter((s) => s.via === "editReply")).toHaveLength(1); // 上書き回帰ピン
    expect(sends.at(-1)).toEqual({
      via: "followUp",
      content: SEND_PARTIAL_FAILED_MESSAGE,
      components: 1,
    });
  });

  it("通知の送信も失敗したら noticeError に格納して resolve する(throw しない)", async () => {
    const { delivery, sends } = fakeDelivery([1, 2]);
    const outcome = await deliverAnswer(delivery, ["a"], buttons);
    expect(outcome.sentChunks).toBe(0);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.noticeError).toBeInstanceOf(Error);
    expect(sends).toEqual([]);
  });

  it("チャンク 0 件なら何も送らない", async () => {
    const { delivery, sends } = fakeDelivery();
    const outcome = await deliverAnswer(delivery, [], buttons);
    expect(outcome).toEqual({ sentChunks: 0, fallbackChunks: 0 });
    expect(sends).toEqual([]);
  });
});

describe("InteractionCreate /ask の分割配送結線(§6.2 / ADR-0034 ephemeral)", () => {
  interface Sent {
    via: "editReply" | "followUp";
    content: string;
    components: number;
    flags: number | undefined;
  }
  function fakeAskInteraction(
    question: string,
    over: { inGuild?: boolean; userId?: string; member?: unknown } = {},
  ): {
    interaction: Interaction;
    sends: Sent[];
    replies: { content: string; ephemeral?: boolean; flags?: number }[];
    deferOptions: () => unknown[];
  } {
    const sends: Sent[] = [];
    const replies: { content: string; ephemeral?: boolean; flags?: number }[] = [];
    const defers: unknown[] = [];
    const push = (via: "editReply" | "followUp") => {
      return async (o: string | { content: string; components?: unknown[]; flags?: number }) => {
        if (typeof o === "string") sends.push({ via, content: o, components: 0, flags: undefined });
        else
          sends.push({
            via,
            content: o.content,
            components: o.components?.length ?? 0,
            flags: o.flags,
          });
      };
    };
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      commandName: "ask",
      inGuild: () => over.inGuild ?? true,
      channel: null,
      channelId: "111",
      appPermissions: { has: () => true },
      member: over.member ?? null,
      user: { id: over.userId ?? "u1" },
      options: { getString: () => question },
      deferReply: async (o?: unknown) => {
        defers.push(o);
      },
      reply: async (o: { content: string; ephemeral?: boolean; flags?: number }) => {
        replies.push(o);
      },
      editReply: push("editReply"),
      followUp: push("followUp"),
    };
    return {
      interaction: interaction as unknown as Interaction,
      sends,
      replies,
      deferOptions: () => defers,
    };
  }

  it("2000 字超の回答: defer は ephemeral flags 付き 1 回・followUp チャンクにも毎回 flags・ボタンは最終メッセージのみ", async () => {
    const { logger } = fakeLogger();
    const first = "あ".repeat(1500);
    const second = "い".repeat(1500);
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      onAsk: async () => ({
        answerText: `${first}\n\n${second}`,
        status: "answered",
        queryId: "q1",
      }),
    });
    const { interaction, sends, deferOptions } = fakeAskInteraction("長い質問");
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    // ADR-0034 D2: 非公開化は defer の時点で確定(editReply は継承・followUp は毎回 flags)。
    expect(deferOptions()).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sends[0]).toEqual({ via: "editReply", content: first, components: 0, flags: undefined });
    expect(sends[1]).toEqual({
      via: "followUp",
      content: second,
      components: 1,
      flags: MessageFlags.Ephemeral,
    });
    await client.destroy();
  });

  it("未回答(NOT_FOUND)も同じ ephemeral defer 経路で editReply 1 通のみ・ボタン無し", async () => {
    const { logger } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      onAsk: async () => ({
        answerText: "見つかりませんでした",
        status: "unanswered",
        queryId: "q2",
      }),
    });
    const { interaction, sends, deferOptions } = fakeAskInteraction("未収載の質問");
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(deferOptions()).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sends[0]).toEqual({
      via: "editReply",
      content: "見つかりませんでした",
      components: 0,
      flags: undefined,
    });
    await client.destroy();
  });

  it("onAsk throw(dispatch 失敗)でも公開送信せず、ephemeral defer への editReply でエラー通知", async () => {
    const { logger } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      onAsk: async () => {
        throw new Error("infra down");
      },
    });
    const { interaction, sends, replies, deferOptions } = fakeAskInteraction("質問");
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(deferOptions()).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sends[0]).toEqual({
      via: "editReply",
      content: ERROR_MESSAGE,
      components: 0,
      flags: undefined,
    });
    expect(replies).toHaveLength(0); // 公開 reply へのフォールバックは存在しない
    await client.destroy();
  });

  it("guild 外(DM)は defer せず ephemeral reply で拒否(質問エコーも公開されない)", async () => {
    const { logger } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      onAsk: async () => ({ answerText: "x", status: "answered", queryId: "q" }),
    });
    const { interaction, sends, replies, deferOptions } = fakeAskInteraction("質問", {
      inGuild: false,
    });
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual({ content: DENY_MESSAGE, ephemeral: true });
    expect(deferOptions()).toHaveLength(0);
    expect(sends).toHaveLength(0);
    await client.destroy();
  });

  describe("ホームチャンネル(ops.home_channel_ids・2026-10-07)", () => {
    const opsHome = (...home_channel_ids: string[]): OpsConfig => ({
      channel_id: null,
      kb_repo: null,
      ask_role_ids: [],
      home_channel_ids,
    });
    const answered = async () => ({
      answerText: "回答",
      status: "answered" as const,
      queryId: "q",
    });

    it("ホーム外の /ask は ephemeral の案内だけ返し、defer も onAsk もしない", async () => {
      const { logger } = fakeLogger();
      const onAsk = vi.fn(answered);
      const client = createBot({
        logger,
        channels: channels(),
        store: createMemoryStore(),
        ops: opsHome("HOME"),
        onAsk,
      });
      const { interaction, sends, replies, deferOptions } = fakeAskInteraction("質問");
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]?.content).toBe(askHomeChannelMessage(["HOME"]));
      expect(replies[0]?.content).toContain("<#HOME>");
      expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
      expect(deferOptions()).toHaveLength(0);
      expect(sends).toHaveLength(0);
      expect(onAsk).not.toHaveBeenCalled();
      await client.destroy();
    });

    it("ホームチャンネル内・空設定(従来どおり)では通常どおり回答する", async () => {
      for (const ops of [opsHome("111"), opsHome()]) {
        const { logger } = fakeLogger();
        const client = createBot({
          logger,
          channels: channels(),
          store: createMemoryStore(),
          ops,
          onAsk: answered,
        });
        const { interaction, sends } = fakeAskInteraction("質問");
        client.emit(Events.InteractionCreate, interaction);
        await vi.waitFor(() => expect(sends).toHaveLength(1));
        await client.destroy();
      }
    });
  });

  describe("利用ロール(ops.ask_role_ids・ADR-0036 D7)", () => {
    const opsWithRole = (...ask_role_ids: string[]): OpsConfig => ({
      channel_id: null,
      kb_repo: null,
      ask_role_ids,
      home_channel_ids: [],
    });
    const answered = async () => ({
      answerText: "回答",
      status: "answered" as const,
      queryId: "q",
    });

    it("ロールを持たないメンバーは ephemeral reply で拒否・defer も onAsk もしない", async () => {
      const { logger } = fakeLogger();
      const onAsk = vi.fn(answered);
      const client = createBot({
        logger,
        channels: channels(),
        store: createMemoryStore(),
        ops: opsWithRole("555", "777"),
        onAsk,
      });
      const { interaction, sends, replies, deferOptions } = fakeAskInteraction("質問", {
        member: { roles: ["111"] },
      });
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]).toEqual({ content: ASK_ROLE_DENY_MESSAGE, ephemeral: true });
      expect(deferOptions()).toHaveLength(0);
      expect(sends).toHaveLength(0);
      expect(onAsk).not.toHaveBeenCalled();
      await client.destroy();
    });

    it("ロールを持つメンバー(API 形 roles: string[])は通常どおり回答する", async () => {
      const { logger } = fakeLogger();
      const client = createBot({
        logger,
        channels: channels(),
        store: createMemoryStore(),
        ops: opsWithRole("555", "777"),
        onAsk: answered,
      });
      const { interaction, sends, replies } = fakeAskInteraction("質問", {
        member: { roles: ["111", "555"] },
      });
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      expect(sends[0]?.content).toBe("回答");
      expect(replies).toHaveLength(0);
      await client.destroy();
    });

    it("キャッシュ済み GuildMember 形(roles.cache)でも判定できる", async () => {
      const { logger } = fakeLogger();
      const client = createBot({
        logger,
        channels: channels(),
        store: createMemoryStore(),
        ops: opsWithRole("555", "777"),
        onAsk: answered,
      });
      const { interaction, sends } = fakeAskInteraction("質問", {
        member: { roles: { cache: new Map([["555", {}]]) } },
      });
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      await client.destroy();
    });

    it("メンバー情報が無い(判定不能)は拒否する(安全側)", async () => {
      const { logger } = fakeLogger();
      const client = createBot({
        logger,
        channels: channels(),
        store: createMemoryStore(),
        ops: opsWithRole("555", "777"),
        onAsk: answered,
      });
      const { interaction, replies, deferOptions } = fakeAskInteraction("質問");
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]).toEqual({ content: ASK_ROLE_DENY_MESSAGE, ephemeral: true });
      expect(deferOptions()).toHaveLength(0);
      await client.destroy();
    });

    it("ask_role_ids が空ならメンバー情報が無くても従来どおり回答する", async () => {
      const { logger } = fakeLogger();
      const client = createBot({
        logger,
        channels: channels(),
        store: createMemoryStore(),
        ops: opsWithRole(),
        onAsk: answered,
      });
      const { interaction, sends } = fakeAskInteraction("質問");
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      await client.destroy();
    });

    it("拒否はレート制限の予算を消費しない", async () => {
      const { logger } = fakeLogger();
      const store = createMemoryStore();
      const client = createBot({
        logger,
        channels: channels(),
        store,
        ops: opsWithRole("555", "777"),
        onAsk: answered,
      });
      for (let i = 0; i < 6; i += 1) {
        const denied = fakeAskInteraction(`質問 ${i}`, { member: { roles: [] } });
        client.emit(Events.InteractionCreate, denied.interaction);
        await vi.waitFor(() => expect(denied.replies).toHaveLength(1));
      }
      const ok = fakeAskInteraction("質問", { member: { roles: ["555"] } });
      client.emit(Events.InteractionCreate, ok.interaction);
      await vi.waitFor(() => expect(ok.sends).toHaveLength(1));
      expect(ok.replies).toHaveLength(0);
      await client.destroy();
    });
  });

  it("同じ人の連続質問は回数で止めない(1 人あたりの上限は無し)", async () => {
    const { logger } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      onAsk: async () => ({ answerText: "ok", status: "answered", queryId: "q" }),
    });
    for (let i = 0; i < 8; i += 1) {
      const f = fakeAskInteraction(`質問 ${i}`);
      client.emit(Events.InteractionCreate, f.interaction);
      await vi.waitFor(() => expect(f.sends).toHaveLength(1));
      expect(f.replies).toHaveLength(0);
    }
    await client.destroy();
  });

  it("rate-limit 超過(チャンネル全体で 21 回目)は ephemeral reply で拒否・defer しない", async () => {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    const client = createBot({
      logger,
      channels: channels(),
      store,
      onAsk: async () => ({ answerText: "ok", status: "answered", queryId: "q" }),
    });
    const probe = fakeAskInteraction("probe");
    // 同じ 10 分バケットの予算を先に使い切る(チャンネル ID は fake と同じ)。
    for (let i = 0; i < RATE_LIMITS.channel; i += 1) {
      store.hitRateLimit(
        `channel:${probe.interaction.channelId}`,
        "ask",
        windowKey(Date.now()),
        RATE_LIMITS.channel,
      );
    }
    client.emit(Events.InteractionCreate, probe.interaction);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    expect(probe.replies[0]).toMatchObject({ ephemeral: true });
    expect(probe.replies[0]?.content).toContain("リクエストが多すぎます");
    expect(probe.deferOptions()).toHaveLength(0);
    expect(probe.sends).toHaveLength(0);
    await client.destroy();
  });
});

// --- ADR-0035: /ask の時間予算(失効時 DM 配送・失効エラーの封じ込め) ---

/** discord.js が interaction 失効時に投げる形の DiscordAPIError(10062 = UnknownInteraction)。 */
function unknownInteractionError(): DiscordAPIError {
  return new DiscordAPIError(
    { message: "Unknown interaction", code: RESTJSONErrorCodes.UnknownInteraction },
    RESTJSONErrorCodes.UnknownInteraction,
    404,
    "POST",
    "https://discord.com/api/v10/interactions/x/y/callback",
    {},
  );
}

describe("interactionLikelyExpired / isExpiredInteractionError (ADR-0035 D2/D3)", () => {
  it("受付から 15 分 − 余裕 を超えたら失効扱い", () => {
    const t0 = 1_000_000;
    const limit = INTERACTION_TOKEN_MS - INTERACTION_DEADLINE_MARGIN_MS;
    expect(interactionLikelyExpired(t0, t0 + limit)).toBe(false);
    expect(interactionLikelyExpired(t0, t0 + limit + 1)).toBe(true);
  });

  it("UnknownInteraction / InteractionHasAlreadyBeenAcknowledged / InvalidWebhookToken だけを失効エラーと判定する", () => {
    expect(isExpiredInteractionError(unknownInteractionError())).toBe(true);
    // 15 分を過ぎた interaction webhook の編集で返る(ADR-0035 追記)。
    const invalidToken = new DiscordAPIError(
      { message: "Invalid Webhook Token", code: RESTJSONErrorCodes.InvalidWebhookToken },
      RESTJSONErrorCodes.InvalidWebhookToken,
      401,
      "PATCH",
      "u",
      {},
    );
    expect(isExpiredInteractionError(invalidToken)).toBe(true);
    const acked = new DiscordAPIError(
      { message: "already acked", code: RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged },
      RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged,
      400,
      "POST",
      "u",
      {},
    );
    expect(isExpiredInteractionError(acked)).toBe(true);
    const other = new DiscordAPIError(
      { message: "invalid form body", code: RESTJSONErrorCodes.InvalidFormBodyOrContentType },
      RESTJSONErrorCodes.InvalidFormBodyOrContentType,
      400,
      "POST",
      "u",
      {},
    );
    expect(isExpiredInteractionError(other)).toBe(false);
    expect(isExpiredInteractionError(new Error("plain"))).toBe(false);
  });
});

describe("deliverAnswer の失効時 DM フォールバック(ADR-0035 D2)", () => {
  type Sent = { via: "editReply" | "followUp" | "dm"; content: string; components: number };
  function fakeDelivery(opts: { failOn: number[]; expired: boolean; dmFails?: boolean }): {
    delivery: Parameters<typeof deliverAnswer>[0];
    sends: Sent[];
  } {
    const sends: Sent[] = [];
    let calls = 0;
    const record = (via: "editReply" | "followUp") => {
      return async (m: { content: string; components: unknown[] }) => {
        calls += 1;
        if (opts.failOn.includes(calls)) {
          throw opts.expired ? unknownInteractionError() : new Error(`send failure #${calls}`);
        }
        sends.push({ via, content: m.content, components: m.components.length });
      };
    };
    return {
      delivery: {
        editReply: record("editReply"),
        followUp: record("followUp"),
        fallback: async (m) => {
          if (opts.dmFails === true) throw new Error("dm closed");
          sends.push({ via: "dm", content: m.content, components: m.components.length });
        },
        isExpired: isExpiredInteractionError,
      },
      sends,
    };
  }
  const buttons = [feedbackButtons("q1")];

  it("先頭で失効したら全チャンクを DM で届け、先頭に断り書き・👍👎 は末尾のみ", async () => {
    const { delivery, sends } = fakeDelivery({ failOn: [1], expired: true });
    const outcome = await deliverAnswer(delivery, ["a", "b"], buttons);
    expect(outcome).toEqual({ sentChunks: 0, fallbackChunks: 2 });
    expect(sends).toEqual([
      { via: "dm", content: `${DM_FALLBACK_NOTE}\na`, components: 0 },
      { via: "dm", content: "b", components: 1 },
    ]);
  });

  it("途中で失効したら残りだけを DM で届ける(配送済みは重複させない)", async () => {
    const { delivery, sends } = fakeDelivery({ failOn: [2], expired: true });
    const outcome = await deliverAnswer(delivery, ["a", "b", "c"], buttons);
    expect(outcome).toEqual({ sentChunks: 1, fallbackChunks: 2 });
    expect(sends.map((x) => x.via)).toEqual(["editReply", "dm", "dm"]);
    expect(sends[1]?.content).toBe(`${DM_FALLBACK_NOTE}\nb`);
    expect(sends[2]).toEqual({ via: "dm", content: "c", components: 1 });
  });

  it("失効以外のエラーでは DM に逃げず従来の失敗通知", async () => {
    const { delivery, sends } = fakeDelivery({ failOn: [1], expired: false });
    const outcome = await deliverAnswer(delivery, ["a"], buttons);
    expect(outcome.fallbackChunks).toBe(0);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(sends.map((x) => x.via)).toEqual(["editReply"]); // SEND_FAILED_MESSAGE の editReply
  });

  it("DM も失敗したら error + noticeError を返し throw しない", async () => {
    const { delivery } = fakeDelivery({ failOn: [1], expired: true, dmFails: true });
    const outcome = await deliverAnswer(delivery, ["a"], buttons);
    expect(outcome.sentChunks).toBe(0);
    expect(outcome.fallbackChunks).toBe(0);
    expect(isExpiredInteractionError(outcome.error)).toBe(true);
    expect(outcome.noticeError).toBeInstanceOf(Error);
  });
});

describe("InteractionCreate /ask の失効封じ込め(ADR-0035 D2/D3)", () => {
  function fakeAskInteraction(opts: { deferThrows?: unknown; editThrows?: unknown } = {}): {
    interaction: Interaction;
    edits: string[];
    dms: { content: string; components: number }[];
    defers: number;
  } {
    const edits: string[] = [];
    const dms: { content: string; components: number }[] = [];
    let defers = 0;
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      commandName: "ask",
      inGuild: () => true,
      channel: null,
      channelId: "111",
      appPermissions: { has: () => true },
      user: {
        id: "u1",
        send: async (m: { content: string; components: unknown[] }) => {
          dms.push({ content: m.content, components: m.components.length });
        },
      },
      options: { getString: () => "質問" },
      deferReply: async () => {
        defers += 1;
        if (opts.deferThrows !== undefined) throw opts.deferThrows;
      },
      reply: async () => {},
      editReply: async (o: string | { content: string }) => {
        if (opts.editThrows !== undefined) throw opts.editThrows;
        edits.push(typeof o === "string" ? o : o.content);
      },
      followUp: async () => {},
    };
    return { interaction: interaction as unknown as Interaction, edits, dms, defers };
  }

  it("deferReply が UnknownInteraction を投げたら warn で終わり onAsk を呼ばない", async () => {
    const { logger, warns } = fakeLogger();
    let asked = 0;
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      onAsk: async () => {
        asked += 1;
        return { answerText: "x", status: "answered", queryId: "q" };
      },
    });
    const fake = fakeAskInteraction({ deferThrows: unknownInteractionError() });
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(warns.length).toBeGreaterThan(0));
    expect(asked).toBe(0);
    expect(fake.dms).toEqual([]);
    await client.destroy();
  });

  it("キュー待ちで 15 分を超えて順番が来たら検索せず、editReply を試みず DM で通知する(ADR-0035 追記)", async () => {
    const { logger } = fakeLogger();
    let t = 0;
    let asked = 0;
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      // 呼ぶたびに 15 分進む(受付 → 進捗開始 → 順番 → 配送のいずれも 15 分以上離れる)。
      now: () => {
        t += INTERACTION_TOKEN_MS;
        return t;
      },
      onAsk: async () => {
        asked += 1;
        return { answerText: "回答本文", status: "answered", queryId: "q9" };
      },
    });
    const fake = fakeAskInteraction();
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(fake.dms).toHaveLength(1));
    expect(asked).toBe(0);
    expect(fake.edits).toEqual([]);
    expect(fake.dms[0]).toEqual({ content: DEADLINE_SKIPPED_MESSAGE, components: 0 });
    await client.destroy();
  });

  it("editReply が失効エラーなら同じ回答を DM で配送する", async () => {
    const { logger } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      onAsk: async () => ({ answerText: "回答本文", status: "answered", queryId: "q9" }),
    });
    const fake = fakeAskInteraction({ editThrows: unknownInteractionError() });
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(fake.dms).toHaveLength(1));
    expect(fake.dms[0]).toEqual({ content: `${DM_FALLBACK_NOTE}\n回答本文`, components: 1 });
    await client.destroy();
  });
});

describe("InteractionCreate /ask の進捗ライブ表示(ADR-0035 D5)", () => {
  it("待機中に進捗 edit が流れ、最終 editReply は回答本文・その後に進捗 edit は来ない", async () => {
    const { logger } = fakeLogger();
    const edits: string[] = [];
    const ask: { resolve: (() => void) | null } = { resolve: null };
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      askTimeoutMs: 600_000,
      progressIntervalMs: 5,
      onAsk: async (_q, ctx) => {
        ctx.onProgress?.({ kind: "sync" });
        ctx.onProgress?.({ kind: "search" });
        ctx.onProgress?.({ kind: "tool_use", tool: "Grep", turn: 1 });
        await new Promise<void>((res) => {
          ask.resolve = res;
        });
        return { answerText: "最終回答", status: "answered", queryId: "q1" };
      },
    });
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      commandName: "ask",
      inGuild: () => true,
      channel: null,
      channelId: "111",
      appPermissions: { has: () => true },
      user: { id: "u1", send: async () => {} },
      options: { getString: () => "質問" },
      deferReply: async () => {},
      reply: async () => {},
      editReply: async (o: string | { content: string }) => {
        edits.push(typeof o === "string" ? o : o.content);
      },
      followUp: async () => {},
    } as unknown as Interaction;
    client.emit(Events.InteractionCreate, interaction);
    // 進捗 edit が少なくとも 1 回流れるのを待ってから回答を解決する。
    await vi.waitFor(() => expect(edits.length).toBeGreaterThan(0));
    expect(edits[0]).toContain("調べています…");
    expect(edits[0]).toContain("参照 1 ファイル(上限 600 秒)");
    ask.resolve?.();
    await vi.waitFor(() => expect(edits.at(-1)).toBe("最終回答"));
    const finalIdx = edits.length;
    await new Promise((res) => setTimeout(res, 30));
    expect(edits.length).toBe(finalIdx); // stop 後に古い tick が回答を上書きしない
    await client.destroy();
  });
});

describe("InteractionCreate /ask の期限・再起動(ADR-0035 追記)", () => {
  interface AskFake {
    interaction: Interaction;
    edits: string[];
    dms: string[];
    replies: { content: string; flags?: number }[];
    defers: () => number;
  }
  function fakeAsk(n = 1): AskFake {
    const edits: string[] = [];
    const dms: string[] = [];
    const replies: { content: string; flags?: number }[] = [];
    let defers = 0;
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      commandName: "ask",
      inGuild: () => true,
      channel: null,
      channelId: "111",
      applicationId: "app-1",
      token: `interaction-token-${n}`,
      appPermissions: { has: () => true },
      user: {
        id: `u${n}`,
        send: async (m: { content: string }) => {
          dms.push(m.content);
        },
      },
      options: { getString: () => `質問${n}` },
      deferReply: async () => {
        defers += 1;
      },
      reply: async (o: { content: string; flags?: number }) => {
        replies.push(o);
      },
      editReply: async (o: string | { content: string }) => {
        edits.push(typeof o === "string" ? o : o.content);
      },
      followUp: async () => {},
    };
    return {
      interaction: interaction as unknown as Interaction,
      edits,
      dms,
      replies,
      defers: () => defers,
    };
  }

  /** 手動で進める fake タイマ(正常終了の猶予待ちを即時に進める)。 */
  function manualTimers() {
    let now = 0;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
      setTimer: (fn: () => void, ms: number) => {
        seq += 1;
        timers.set(seq, { at: now + ms, fn });
        return seq;
      },
      clearTimer: (h: unknown) => {
        timers.delete(h as number);
      },
      advance: (ms: number) => {
        now += ms;
        for (const [id, t] of [...timers]) {
          if (t.at <= now) {
            timers.delete(id);
            t.fn();
          }
        }
      },
    };
  }

  /** 先頭に置いて順番待ちを作るためのブロッカー。 */
  function blockQueue(queue: SerialQueue): () => void {
    let release: () => void = () => {};
    void queue.enqueue(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    return () => release();
  }

  const statuses = (store: BotStore) => store.listQueries().map((q) => q.answerStatus);

  it("期限切れ(14 分超)だが token がまだ使える(15 分未満)なら、検索せず ephemeral を書き換えて timeout_skipped を記録", async () => {
    const { logger, warns } = fakeLogger();
    const store = createMemoryStore();
    const queue = new SerialQueue();
    let t = 0;
    let asked = 0;
    const client = createBot({
      logger,
      channels: channels(),
      store,
      queue,
      now: () => t,
      progressIntervalMs: 1_000_000,
      onAsk: async () => {
        asked += 1;
        return { answerText: "回答", status: "answered", queryId: "q" };
      },
    });
    const release = blockQueue(queue);
    const fake = fakeAsk();
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(fake.defers()).toBe(1));
    await new Promise((res) => setTimeout(res, 0));
    t = 14.5 * 60_000; // 全体期限(14 分)は過ぎたが token は有効
    release();
    await vi.waitFor(() => expect(fake.edits).toEqual([DEADLINE_SKIPPED_MESSAGE]));
    expect(asked).toBe(0); // 検索しない
    expect(fake.dms).toEqual([]);
    expect(statuses(store)).toEqual(["timeout_skipped"]);
    expect(store.listQueries()[0]).toMatchObject({ question: "質問1", discordUserId: "u1" });
    expect(warns.length).toBeGreaterThan(0); // ログに残す
    await client.destroy();
  });

  it("期限内に始まった検索が長引き、配送時点で期限を過ぎていたら DM で配送する(ADR-0035 D2 (b))", async () => {
    const { logger } = fakeLogger();
    let t = 0;
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      now: () => t,
      progressIntervalMs: 1_000_000,
      onAsk: async () => {
        t = 14 * 60_000 + 1;
        return { answerText: "回答本文", status: "answered", queryId: "q9" };
      },
    });
    const fake = fakeAsk();
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(fake.dms).toHaveLength(1));
    expect(fake.dms[0]).toBe(`${DM_FALLBACK_NOTE}\n回答本文`);
    expect(fake.edits).toEqual([]);
    await client.destroy();
  });

  it("停止開始後の /ask は defer せず ephemeral で「再起動中」を返し、検索もレート制限の消費もしない", async () => {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    const lifecycle = createAskLifecycle({ newId: () => "x" });
    await lifecycle.shutdown();
    let asked = 0;
    const client = createBot({
      logger,
      channels: channels(),
      store,
      lifecycle,
      onAsk: async () => {
        asked += 1;
        return { answerText: "x", status: "answered", queryId: "q" };
      },
    });
    const fake = fakeAsk();
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(fake.replies).toHaveLength(1));
    expect(fake.replies[0]).toEqual({
      content: SHUTTING_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    expect(fake.defers()).toBe(0);
    expect(asked).toBe(0);
    expect(store.listQueries()).toEqual([]);
    // レート制限の予算を消費していない(次の hit が 1 件目になる)。
    expect(
      store.hitRateLimit(`channel:${fake.interaction.channelId}`, "ask", windowKey(Date.now()), 20)
        .count,
    ).toBe(1);
    await client.destroy();
  });

  it("処理中の token を inflight_asks に記録し、完了したら即削除する", async () => {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    const lifecycle = createAskLifecycle({ store, newId: () => "row-1" });
    const gate: { release: () => void } = { release: () => {} };
    const client = createBot({
      logger,
      channels: channels(),
      store,
      lifecycle,
      progressIntervalMs: 1_000_000,
      onAsk: async () => {
        await new Promise<void>((res) => {
          gate.release = res;
        });
        return { answerText: "回答", status: "unanswered", queryId: "q" };
      },
    });
    const fake = fakeAsk();
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(store.listInflightAsks()).toHaveLength(1));
    expect(store.listInflightAsks()[0]).toMatchObject({
      id: "row-1",
      applicationId: "app-1",
      token: "interaction-token-1",
    });
    gate.release();
    await vi.waitFor(() => expect(fake.edits.at(-1)).toBe("回答"));
    await vi.waitFor(() => expect(store.listInflightAsks()).toEqual([]));
    expect(lifecycle.inflight).toBe(0);
    await client.destroy();
  });

  it("正常終了: 処理中の /ask が猶予内に終われば中断せず回答を届ける", async () => {
    const { logger } = fakeLogger();
    const timers = manualTimers();
    const lifecycle = createAskLifecycle({ newId: () => "r", graceMs: 60_000, ...timers });
    const gate: { release: () => void } = { release: () => {} };
    let signal: AbortSignal | undefined;
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      lifecycle,
      progressIntervalMs: 1_000_000,
      onAsk: async (_q, ctx) => {
        signal = ctx.signal;
        await new Promise<void>((res) => {
          gate.release = res;
        });
        return { answerText: "最終回答", status: "unanswered", queryId: "q" };
      },
    });
    const fake = fakeAsk();
    client.emit(Events.InteractionCreate, fake.interaction);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const done = lifecycle.shutdown();
    timers.advance(30_000);
    gate.release();
    await expect(done).resolves.toMatchObject({ drained: true, aborted: 0 });
    expect(fake.edits.at(-1)).toBe("最終回答");
    expect(signal?.aborted).toBe(false);
    await client.destroy();
  });

  it("正常終了: 猶予を超えたら検索中の /ask を中断し、順番待ちの /ask は検索せず、どちらも中断通知と interrupted を記録", async () => {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    const timers = manualTimers();
    let n = 0;
    const lifecycle = createAskLifecycle({
      store,
      newId: () => `r${++n}`,
      graceMs: 60_000,
      abortSettleMs: 15_000,
      ...timers,
    });
    const queue = new SerialQueue();
    const askedQuestions: string[] = [];
    const client = createBot({
      logger,
      channels: channels(),
      store,
      queue,
      lifecycle,
      progressIntervalMs: 1_000_000,
      // handleAskRequest 相当: 中断されたら interrupted を記録して返す。
      onAsk: async (q, ctx) => {
        askedQuestions.push(q);
        await new Promise<void>((res) => {
          ctx.signal?.addEventListener("abort", () => res(), { once: true });
        });
        store.recordQuery({
          id: "q-running",
          correlationId: ctx.correlationId,
          discordUserId: ctx.userId,
          discordChannelId: ctx.channelId,
          threadId: null,
          question: q,
          answer: null,
          sourcesJson: null,
          answerStatus: "interrupted",
          feedback: null,
          inputTokens: null,
          outputTokens: null,
          elapsedMs: null,
          createdAt: "t",
        });
        return { answerText: INTERRUPTED_MESSAGE, status: "interrupted", queryId: "q-running" };
      },
    });
    const running = fakeAsk(1);
    const queued = fakeAsk(2);
    client.emit(Events.InteractionCreate, running.interaction);
    await vi.waitFor(() => expect(askedQuestions).toEqual(["質問1"]));
    client.emit(Events.InteractionCreate, queued.interaction);
    await vi.waitFor(() => expect(lifecycle.inflight).toBe(2));
    expect(store.listInflightAsks()).toHaveLength(2);

    const done = lifecycle.shutdown();
    // 停止中に届いた新規 /ask は拒否される。
    const late = fakeAsk(3);
    client.emit(Events.InteractionCreate, late.interaction);
    await vi.waitFor(() => expect(late.replies[0]?.content).toBe(SHUTTING_DOWN_MESSAGE));

    timers.advance(60_000);
    await expect(done).resolves.toEqual({
      inflightAtStart: 2,
      drained: false,
      aborted: 2,
      unsettled: 0,
    });
    expect(running.edits.at(-1)).toBe(INTERRUPTED_MESSAGE);
    expect(queued.edits.at(-1)).toBe(INTERRUPTED_MESSAGE);
    expect(askedQuestions).toEqual(["質問1"]); // 順番待ちの質問は検索しない
    expect(statuses(store).sort()).toEqual(["interrupted", "interrupted"]);
    expect(store.listQueries().find((q) => q.question === "質問2")).toBeDefined();
    expect(store.listInflightAsks()).toEqual([]); // token は残さない
    // キューに残っていた順番待ちのタスクは何もせずに抜ける(二重通知・記録なし)。
    await queue.enqueue(async () => {});
    expect(queued.edits.filter((e) => e === INTERRUPTED_MESSAGE)).toHaveLength(1);
    expect(store.listQueries()).toHaveLength(2);
    await client.destroy();
  });
});

describe("InteractionCreate /ask の完了ログ(段階 1-1: 1 件 1 行・工程別の時間)", () => {
  function askInteraction(opts: { editThrows?: unknown } = {}): {
    interaction: Interaction;
    edits: string[];
  } {
    const edits: string[] = [];
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      commandName: "ask",
      inGuild: () => true,
      channel: null,
      channelId: "111",
      appPermissions: { has: () => true },
      user: { id: "u1", send: async () => {} },
      options: { getString: () => "秘密の質問本文" },
      deferReply: async () => {},
      reply: async () => {},
      editReply: async (o: string | { content: string }) => {
        const content = typeof o === "string" ? o : o.content;
        // 失敗させるのは回答の配送だけ(エラー通知・進捗は通す)。
        if (opts.editThrows !== undefined && content === "回答本文") throw opts.editThrows;
        edits.push(content);
      },
      followUp: async () => {},
    };
    return { interaction: interaction as unknown as Interaction, edits };
  }
  const completions = (infos: { obj: Record<string, unknown>; msg: string | undefined }[]) =>
    infos.filter((i) => i.msg === ASK_COMPLETION_LOG_MSG).map((i) => i.obj);
  /** 呼ばれるたびに 100ms 進む壁時計。 */
  const ticking = () => {
    let t = 0;
    return () => (t += 100);
  };
  const okResult: AskResult = {
    answerText: "回答本文",
    status: "answered",
    queryId: "q1",
    metrics: {
      syncMs: 1500,
      promptMs: 2,
      searchMs: 40_000,
      validateMs: 3,
      elapsedMs: 41_505,
      sync: null,
      search: null,
      usage: null,
      failure: null,
    },
  };

  it("成功時はキュー待ち・配送を含む完了ログを 1 行だけ出す(質問本文は載せない)", async () => {
    const { logger, infos } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      now: ticking(),
      onAsk: async () => okResult,
    });
    client.emit(Events.InteractionCreate, askInteraction().interaction);
    await vi.waitFor(() => expect(completions(infos)).toHaveLength(1));
    const log = completions(infos)[0] ?? {};
    expect(log).toMatchObject({
      outcome: "answered",
      queryId: "q1",
      syncMs: 1500,
      promptMs: 2,
      searchMs: 40_000,
      validateMs: 3,
      elapsedMs: 41_505,
      expired: false,
    });
    expect(typeof log.queueWaitMs).toBe("number");
    expect(typeof log.deliveryMs).toBe("number");
    expect(log.totalMs as number).toBeGreaterThanOrEqual(
      (log.queueWaitMs as number) + (log.deliveryMs as number),
    );
    expect("failedStage" in log).toBe(false);
    expect(JSON.stringify(infos)).not.toContain("秘密の質問本文");
    await client.destroy();
  });

  it("パイプライン内の失敗は metrics.failure の工程をそのまま載せる", async () => {
    const { logger, infos } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      now: ticking(),
      onAsk: async () => ({
        answerText: ERROR_MESSAGE,
        status: "error",
        queryId: "q2",
        metrics: {
          syncMs: null,
          promptMs: null,
          searchMs: null,
          validateMs: null,
          elapsedMs: 700,
          sync: null,
          search: null,
          usage: null,
          failure: { stage: "sync", atMs: 700, errorKind: "GitError", errorCode: "GIT_DNS" },
        },
      }),
    });
    client.emit(Events.InteractionCreate, askInteraction().interaction);
    await vi.waitFor(() => expect(completions(infos)).toHaveLength(1));
    const log = completions(infos)[0] ?? {};
    expect(log).toMatchObject({
      outcome: "error",
      failedStage: "sync",
      errorKind: "GitError",
      errorCode: "GIT_DNS",
    });
    expect(log.failedAtMs).toBe((log.queueWaitMs as number) + 700);
    await client.destroy();
  });

  it("onAsk 自体の失敗は最後に観測した工程を failedStage にする", async () => {
    const { logger, infos } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      now: ticking(),
      onAsk: async (_q, ctx) => {
        ctx.onProgress?.({ kind: "sync" });
        ctx.onProgress?.({ kind: "search" });
        throw new LlmError("API_ERROR", "down");
      },
    });
    const { interaction, edits } = askInteraction();
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(completions(infos)).toHaveLength(1));
    expect(edits.at(-1)).toBe(ERROR_MESSAGE);
    expect(completions(infos)[0]).toMatchObject({
      outcome: "error",
      queryId: null,
      failedStage: "search",
      errorKind: "LlmError",
      errorCode: "API_ERROR",
      deliveryMs: null,
    });
    await client.destroy();
  });

  it("配送の失敗(失効以外)は failedStage: delivery", async () => {
    const { logger, infos } = fakeLogger();
    const client = createBot({
      logger,
      channels: channels(),
      store: createMemoryStore(),
      now: ticking(),
      onAsk: async () => okResult,
    });
    client.emit(
      Events.InteractionCreate,
      askInteraction({ editThrows: new Error("500 internal") }).interaction,
    );
    await vi.waitFor(() => expect(completions(infos)).toHaveLength(1));
    const log = completions(infos)[0] ?? {};
    expect(log).toMatchObject({ outcome: "answered", failedStage: "delivery", errorKind: "Error" });
    expect(log.failedAtMs).toBe(log.totalMs);
    await client.destroy();
  });
});

// --- 📌 残す / 📢 共有(ADR-0040)-------------------------------------------------

function answeredRecord(over: Partial<QueryRecord> = {}): QueryRecord {
  return {
    id: "q1",
    correlationId: "c1",
    discordUserId: "u1",
    discordChannelId: "111",
    threadId: null,
    question: "勤怠の締め日は?",
    answer: "毎月末です。\n\n出典:\n[1] https://github.com/org/kb/blob/abc/a.md",
    sourcesJson: JSON.stringify([
      { kind: "github_file", repo: "org/kb", path: "a.md", ref: "abc" },
    ]),
    answerStatus: "answered",
    feedback: null,
    inputTokens: 1,
    outputTokens: 1,
    elapsedMs: 1,
    createdAt: "2026-10-07T09:12:34+09:00",
    ...over,
  };
}

const DISCORD_CITED_SOURCES = JSON.stringify([
  { kind: "github_file", repo: "org/kb", path: "a.md", ref: "abc" },
  { kind: "discord", url: "https://discord.com/channels/1/2/3" },
]);

/** ボタン行(ActionRowBuilder[])の customId 一覧。 */
function customIdsOf(rows: unknown[] | undefined): string[] {
  return (rows ?? []).flatMap((r) =>
    (r as { toJSON(): { components: { custom_id?: string }[] } })
      .toJSON()
      .components.map((c) => c.custom_id ?? ""),
  );
}

describe("parseFeedbackCustomId / feedbackButtons(📌 / 📢・ADR-0040)", () => {
  it("fb:keep / fb:share / fb:share-confirm / fb:share-cancel を解析する", () => {
    expect(parseFeedbackCustomId("fb:keep:q1")).toEqual({ value: "keep", queryId: "q1" });
    expect(parseFeedbackCustomId("fb:share:q1")).toEqual({ value: "share", queryId: "q1" });
    expect(parseFeedbackCustomId("fb:share-confirm:q-1")).toEqual({
      value: "share-confirm",
      queryId: "q-1",
    });
    expect(parseFeedbackCustomId("fb:share-cancel:q1")).toEqual({
      value: "share-cancel",
      queryId: "q1",
    });
    for (const id of ["fb:keep:", "fb:share-:q1", "fb:sharex:q1", "fb:share-confirm:"]) {
      expect(parseFeedbackCustomId(id)).toBeNull();
    }
  });

  it("keep / share 指定で同じ行に 📌 / 📢 を足す(既定は 👍👎 のみ)", () => {
    expect(customIdsOf([feedbackButtons("q1", { keep: true })])).toEqual([
      "fb:up:q1",
      "fb:down:q1",
      "fb:keep:q1",
    ]);
    expect(customIdsOf([feedbackButtons("q1", { keep: true, share: true })])).toEqual([
      "fb:up:q1",
      "fb:down:q1",
      "fb:keep:q1",
      "fb:share:q1",
    ]);
  });
});

describe("InteractionCreate /ask の 📌 / 📢 ボタン(ADR-0040)", () => {
  interface Sent {
    via: "editReply" | "followUp" | "dm";
    ids: string[];
  }
  function askFake(opts: { editThrows?: unknown } = {}): {
    interaction: Interaction;
    sends: Sent[];
  } {
    const sends: Sent[] = [];
    const push =
      (via: Sent["via"], throws?: unknown) =>
      async (o: string | { content: string; components?: unknown[] }) => {
        if (throws !== undefined) throw throws;
        sends.push({ via, ids: typeof o === "string" ? [] : customIdsOf(o.components) });
      };
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      commandName: "ask",
      inGuild: () => true,
      channel: null,
      channelId: "111",
      appPermissions: { has: () => true },
      member: null,
      user: { id: "u1", send: push("dm") },
      options: { getString: () => "質問" },
      deferReply: async () => {},
      reply: async () => {},
      editReply: push("editReply", opts.editThrows),
      followUp: push("followUp"),
    };
    return { interaction: interaction as unknown as Interaction, sends };
  }

  /** onAsk の代わりに記録を入れて answered を返す(handleAskRequest と同じく配送前に記録済み)。 */
  function setup(
    over: {
      record?: Partial<QueryRecord>;
      status?: AskResult["status"];
      share?: boolean;
      now?: () => number;
      onAskHook?: () => void;
    } = {},
  ): ReturnType<typeof createBot> {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    return createBot({
      logger,
      channels: channels(),
      store,
      ...(over.share === false ? {} : { shareChannelId: "SHARE", sharedAnswers: store }),
      ...(over.now !== undefined ? { now: over.now } : {}),
      onAsk: async () => {
        over.onAskHook?.();
        store.recordQuery(answeredRecord(over.record));
        return { answerText: "毎月末です。", status: over.status ?? "answered", queryId: "q1" };
      },
    });
  }

  it("回答あり: 最終メッセージに 👍👎📌📢 を並べる", async () => {
    const client = setup();
    const { interaction, sends } = askFake();
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.ids).toEqual(["fb:up:q1", "fb:down:q1", "fb:keep:q1", "fb:share:q1"]);
    await client.destroy();
  });

  it("Discord の発言を引用した回答には 📢 を出さない(📌 は出す)", async () => {
    const client = setup({ record: { sourcesJson: DISCORD_CITED_SOURCES } });
    const { interaction, sends } = askFake();
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.ids).toEqual(["fb:up:q1", "fb:down:q1", "fb:keep:q1"]);
    await client.destroy();
  });

  it("共有先が未設定なら 📢 を出さない", async () => {
    const client = setup({ share: false });
    const { interaction, sends } = askFake();
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.ids).toEqual(["fb:up:q1", "fb:down:q1", "fb:keep:q1"]);
    await client.destroy();
  });

  it("未回答にはボタンを付けない", async () => {
    const client = setup({ status: "unanswered", record: { answerStatus: "unanswered" } });
    const { interaction, sends } = askFake();
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.ids).toEqual([]);
    await client.destroy();
  });

  it("配送時点で失効していて全体を DM で届けたときは 👍👎 だけ(📌📢 は付けない)", async () => {
    let t = 0;
    // 検索中に 15 分を超える(受付・順番は期限内、配送時点で失効)。
    const client = setup({ now: () => t, onAskHook: () => (t = INTERACTION_TOKEN_MS) });
    const { interaction, sends } = askFake();
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends.filter((s) => s.via === "dm")).toHaveLength(1));
    expect(sends.map((s) => s.via)).toEqual(["dm"]);
    expect(sends[0]?.ids).toEqual(["fb:up:q1", "fb:down:q1"]);
    await client.destroy();
  });

  it("editReply が失効して DM に切り替えたときも DM 側は 👍👎 だけ", async () => {
    const client = setup();
    const { interaction, sends } = askFake({ editThrows: unknownInteractionError() });
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(sends.filter((s) => s.via === "dm")).toHaveLength(1));
    expect(sends.find((s) => s.via === "dm")?.ids).toEqual(["fb:up:q1", "fb:down:q1"]);
    await client.destroy();
  });
});

describe("handleButton の 📌 / 📢(ADR-0040)", () => {
  interface Posted {
    content: string;
    allowedMentions: unknown;
  }
  function keepShareButton(
    customId: string,
    opts: {
      userId?: string;
      dmThrowsAt?: number;
      channel?: "ok" | "missing" | "throws";
      postThrowsAt?: number;
    } = {},
  ): {
    interaction: ButtonInteraction;
    replies: { content: string; flags?: number; components?: unknown[] }[];
    edits: { content: string; components?: unknown[] }[];
    updates: { content: string; components?: unknown[] }[];
    dms: { content: string; allowedMentions: unknown }[];
    posted: Posted[];
    fetchedChannels: string[];
    calls: string[];
  } {
    const replies: { content: string; flags?: number; components?: unknown[] }[] = [];
    const edits: { content: string; components?: unknown[] }[] = [];
    const updates: { content: string; components?: unknown[] }[] = [];
    const dms: { content: string; allowedMentions: unknown }[] = [];
    const posted: Posted[] = [];
    const fetchedChannels: string[] = [];
    const calls: string[] = [];
    let n = 0;
    const channel = {
      isSendable: () => true,
      send: async (m: Posted) => {
        if (opts.postThrowsAt !== undefined && posted.length === opts.postThrowsAt) {
          throw new Error("Missing Access");
        }
        posted.push(m);
        n += 1;
        return { id: `m${n}`, url: `https://discord.com/channels/G/SHARE/m${n}` };
      },
    };
    const interaction = {
      customId,
      guildId: "G",
      replied: false,
      deferred: false,
      user: {
        id: opts.userId ?? "u1",
        send: async (m: { content: string; allowedMentions: unknown }) => {
          if (opts.dmThrowsAt !== undefined && dms.length === opts.dmThrowsAt) {
            throw new DiscordAPIError(
              { code: RESTJSONErrorCodes.CannotSendMessagesToThisUser, message: "Cannot send" },
              RESTJSONErrorCodes.CannotSendMessagesToThisUser,
              403,
              "POST",
              "/channels/x/messages",
              {},
            );
          }
          dms.push(m);
        },
      },
      client: {
        channels: {
          fetch: async (id: string) => {
            fetchedChannels.push(id);
            if (opts.channel === "throws") throw new Error("Unknown Channel");
            return opts.channel === "missing" ? null : channel;
          },
        },
      },
      reply: async (o: { content: string; flags?: number; components?: unknown[] }) => {
        calls.push("reply");
        replies.push(o);
      },
      deferReply: async () => {
        calls.push("deferReply");
        interaction.deferred = true;
      },
      editReply: async (o: { content: string; components?: unknown[] }) => {
        calls.push("editReply");
        edits.push(o);
      },
      update: async (o: { content: string; components?: unknown[] }) => {
        calls.push("update");
        updates.push(o);
      },
      deferUpdate: async () => {
        calls.push("deferUpdate");
        interaction.deferred = true;
      },
    };
    return {
      interaction: interaction as unknown as ButtonInteraction,
      replies,
      edits,
      updates,
      dms,
      posted,
      fetchedChannels,
      calls,
    };
  }

  function setupStore(over: Partial<QueryRecord> = {}): ReturnType<typeof createMemoryStore> {
    const store = createMemoryStore();
    store.recordQuery(answeredRecord(over));
    return store;
  }
  const shareDeps = (
    logger: Logger,
    store: ReturnType<typeof createMemoryStore>,
    share = true,
  ): BotDeps => ({
    logger,
    channels: channels(),
    store,
    ...(share ? { shareChannelId: "SHARE", sharedAnswers: store } : {}),
  });
  const NOT_ASKER = "この操作は /ask を実行した本人のみ行えます。";

  it("本人以外は 📌 / 📢 / 公開する / やめる を使えない(DM も投稿も記録もしない)", async () => {
    const { logger, infos } = fakeLogger();
    const store = setupStore();
    for (const id of ["fb:keep:q1", "fb:share:q1", "fb:share-confirm:q1", "fb:share-cancel:q1"]) {
      const b = keepShareButton(id, { userId: "someone-else" });
      await handleButton(b.interaction, shareDeps(logger, store));
      expect(b.replies).toEqual([{ content: NOT_ASKER, flags: MessageFlags.Ephemeral }]);
      expect(b.dms).toEqual([]);
      expect(b.posted).toEqual([]);
      expect(b.updates).toEqual([]);
    }
    expect(store.getSharedAnswer("q1")).toBeUndefined();
    expect(infos.filter((i) => i.obj.result === "not_asker")).toHaveLength(4);
  });

  it("📌: 保存済みの回答を見出し付きで本人に DM し、ephemeral で「DM に保存しました」", async () => {
    const { logger, infos } = fakeLogger();
    const store = setupStore();
    const b = keepShareButton("fb:keep:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.calls).toEqual(["deferReply", "editReply"]);
    expect(b.dms).toHaveLength(1);
    expect(b.dms[0]?.content).toBe(
      "📌 /ask の回答(2026-10-07 09:12 JST)\n\n**質問**\n> 勤怠の締め日は?\n\n**回答**\n毎月末です。\n\n出典:\n[1] https://github.com/org/kb/blob/abc/a.md",
    );
    expect(b.dms[0]?.allowedMentions).toEqual({ parse: [] });
    expect(b.edits).toEqual([{ content: KEEP_DONE_MESSAGE }]);
    // ログに質問・回答の本文を出さない。
    const keepLog = infos.find((i) => i.obj.action === "keep");
    expect(keepLog?.obj).toEqual({ queryId: "q1", action: "keep", result: "ok", chunks: 1 });
  });

  it("📌: 2000 字を超える回答は分割して全チャンクを DM する(Discord 引用付きでも保存はできる)", async () => {
    const { logger } = fakeLogger();
    const long = `${"あ".repeat(1500)}\n\n${"い".repeat(1500)}`;
    const store = setupStore({ answer: long, sourcesJson: DISCORD_CITED_SOURCES });
    const b = keepShareButton("fb:keep:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.dms.length).toBe(2);
    expect(b.dms.every((d) => d.content.length <= 2000)).toBe(true);
    expect(b.dms.map((d) => d.content).join("\n\n")).toContain(long);
    expect(b.edits).toEqual([{ content: KEEP_DONE_MESSAGE }]);
  });

  it("📌: DM を送れなければ受信設定の案内を ephemeral で返す(token を含む生の例外をログに出さない)", async () => {
    const { logger, warns } = fakeLogger();
    const store = setupStore();
    const b = keepShareButton("fb:keep:q1", { dmThrowsAt: 0 });
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.edits).toEqual([{ content: KEEP_DM_FAILED_MESSAGE }]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      queryId: "q1",
      action: "keep",
      result: "dm_failed",
      sentChunks: 0,
      err: {
        name: "DiscordAPIError[50007]",
        code: RESTJSONErrorCodes.CannotSendMessagesToThisUser,
      },
    });
  });

  it("📌: 途中のチャンクで DM が失敗したら一部だけ届いた旨を案内する", async () => {
    const { logger } = fakeLogger();
    const store = setupStore({ answer: `${"あ".repeat(1500)}\n\n${"い".repeat(1500)}` });
    const b = keepShareButton("fb:keep:q1", { dmThrowsAt: 1 });
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.dms).toHaveLength(1);
    expect(b.edits).toEqual([{ content: KEEP_DM_PARTIAL_MESSAGE }]);
  });

  it("📌 / 📢: 記録の無い回答は拒否する", async () => {
    const { logger } = fakeLogger();
    const store = createMemoryStore();
    for (const id of ["fb:keep:nope", "fb:share:nope"]) {
      const b = keepShareButton(id);
      await handleButton(b.interaction, shareDeps(logger, store));
      expect(b.replies).toEqual([
        { content: RECORD_NOT_FOUND_MESSAGE, flags: MessageFlags.Ephemeral },
      ]);
      expect(b.dms).toEqual([]);
    }
  });

  it("📢: 確認画面(ephemeral・公開する / やめる)を出すだけで、まだ投稿しない", async () => {
    const { logger } = fakeLogger();
    const store = setupStore();
    const b = keepShareButton("fb:share:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.replies).toHaveLength(1);
    expect(b.replies[0]?.content).toBe(shareConfirmMessage("SHARE"));
    expect(b.replies[0]?.content).toBe(
      "この回答を <#SHARE> に公開します。質問と回答がメンバー全員に見えます。",
    );
    expect(b.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(customIdsOf(b.replies[0]?.components)).toEqual([
      "fb:share-confirm:q1",
      "fb:share-cancel:q1",
    ]);
    expect(b.posted).toEqual([]);
    expect(store.getSharedAnswer("q1")).toBeUndefined();
  });

  it("公開する: 共有チャンネルにだけ投稿し(メンションは質問者のみ)、記録して確認画面をリンクに書き換える", async () => {
    const { logger, infos } = fakeLogger();
    const store = setupStore({ answer: "@everyone <@&999> 毎月末です。<@888>" });
    const b = keepShareButton("fb:share-confirm:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.fetchedChannels).toEqual(["SHARE"]);
    expect(b.calls).toEqual(["deferUpdate", "editReply"]);
    expect(b.posted).toEqual([
      {
        content:
          "📢 <@u1> さんの /ask の共有\n\n**質問**\n> 勤怠の締め日は?\n\n**回答**\n@everyone <@&999> 毎月末です。<@888>",
        allowedMentions: { parse: [], users: ["u1"] },
      },
    ]);
    expect(b.edits).toEqual([
      { content: "公開しました: https://discord.com/channels/G/SHARE/m1", components: [] },
    ]);
    expect(store.getSharedAnswer("q1")).toMatchObject({
      queryId: "q1",
      channelId: "SHARE",
      messageId: "m1",
      sharedBy: "u1",
    });
    const okLog = infos.find((i) => i.obj.action === "share-confirm");
    expect(okLog?.obj).toEqual({
      queryId: "q1",
      action: "share-confirm",
      result: "ok",
      chunks: 1,
      channelId: "SHARE",
      messageId: "m1",
    });
  });

  it("公開する: 長い回答は分割して投稿し、全チャンクに同じメンション制限を付ける", async () => {
    const { logger } = fakeLogger();
    const store = setupStore({ answer: `${"あ".repeat(1500)}\n\n${"い".repeat(1500)}` });
    const b = keepShareButton("fb:share-confirm:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.posted).toHaveLength(2);
    for (const p of b.posted) {
      expect(p.content.length).toBeLessThanOrEqual(2000);
      expect(p.allowedMentions).toEqual({ parse: [], users: ["u1"] });
    }
    expect(store.getSharedAnswer("q1")?.messageId).toBe("m1");
  });

  it("やめる: 確認画面を書き換えるだけ(投稿も記録もしない)", async () => {
    const { logger } = fakeLogger();
    const store = setupStore();
    const b = keepShareButton("fb:share-cancel:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.updates).toEqual([{ content: SHARE_CANCELLED_MESSAGE, components: [] }]);
    expect(b.posted).toEqual([]);
    expect(store.getSharedAnswer("q1")).toBeUndefined();
  });

  it("二重共有は拒否する(📢 も 公開する も・リンク付き)", async () => {
    const { logger } = fakeLogger();
    const store = setupStore();
    await handleButton(
      keepShareButton("fb:share-confirm:q1").interaction,
      shareDeps(logger, store),
    );
    const link = "https://discord.com/channels/G/SHARE/m1";
    const again = keepShareButton("fb:share:q1");
    await handleButton(again.interaction, shareDeps(logger, store));
    expect(again.replies).toEqual([
      { content: alreadySharedMessage(link), flags: MessageFlags.Ephemeral },
    ]);
    expect(alreadySharedMessage(link)).toBe(`この回答はすでに共有されています: ${link}`);
    const confirm = keepShareButton("fb:share-confirm:q1");
    await handleButton(confirm.interaction, shareDeps(logger, store));
    expect(confirm.updates).toEqual([{ content: alreadySharedMessage(link), components: [] }]);
    expect(confirm.posted).toEqual([]);
  });

  it("投稿前の予約が残っている(処理中)ときも投稿しない", async () => {
    const { logger } = fakeLogger();
    const store = setupStore();
    store.claimSharedAnswer({
      queryId: "q1",
      sharedAt: "2026-10-07T10:00:00+09:00",
      channelId: "SHARE",
      sharedBy: "u1",
    });
    const b = keepShareButton("fb:share-confirm:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.updates).toEqual([{ content: alreadySharedMessage(null), components: [] }]);
    expect(b.posted).toEqual([]);
  });

  it("Discord 引用付きの回答は、偽造された 公開する でも拒否する(ADR-0038)", async () => {
    const { logger, infos } = fakeLogger();
    const store = setupStore({ sourcesJson: DISCORD_CITED_SOURCES });
    const share = keepShareButton("fb:share:q1");
    await handleButton(share.interaction, shareDeps(logger, store));
    expect(share.replies).toEqual([
      { content: SHARE_DISCORD_CITED_MESSAGE, flags: MessageFlags.Ephemeral },
    ]);
    const b = keepShareButton("fb:share-confirm:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.updates).toEqual([{ content: SHARE_DISCORD_CITED_MESSAGE, components: [] }]);
    expect(b.fetchedChannels).toEqual([]);
    expect(b.posted).toEqual([]);
    expect(store.getSharedAnswer("q1")).toBeUndefined();
    expect(infos.some((i) => i.obj.result === "discord_cited")).toBe(true);
  });

  it("出典が読めない記録も共有しない(安全側)", async () => {
    const { logger } = fakeLogger();
    const store = setupStore({ sourcesJson: "{broken" });
    const b = keepShareButton("fb:share-confirm:q1");
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.updates).toEqual([{ content: SHARE_DISCORD_CITED_MESSAGE, components: [] }]);
    expect(b.posted).toEqual([]);
  });

  it("共有先が未設定なら 📢 / 公開する を拒否する", async () => {
    const { logger } = fakeLogger();
    const store = setupStore();
    const share = keepShareButton("fb:share:q1");
    await handleButton(share.interaction, shareDeps(logger, store, false));
    expect(share.replies).toEqual([
      { content: SHARE_UNAVAILABLE_MESSAGE, flags: MessageFlags.Ephemeral },
    ]);
    const b = keepShareButton("fb:share-confirm:q1");
    await handleButton(b.interaction, shareDeps(logger, store, false));
    expect(b.updates).toEqual([{ content: SHARE_UNAVAILABLE_MESSAGE, components: [] }]);
    expect(b.fetchedChannels).toEqual([]);
  });

  it("投稿に失敗したら予約を外して失敗を伝える(再試行できる)", async () => {
    const { logger, warns } = fakeLogger();
    const store = setupStore();
    for (const channel of ["missing", "throws"] as const) {
      const b = keepShareButton("fb:share-confirm:q1", { channel });
      await handleButton(b.interaction, shareDeps(logger, store));
      expect(b.edits).toEqual([{ content: SHARE_FAILED_MESSAGE, components: [] }]);
      expect(store.getSharedAnswer("q1")).toBeUndefined();
    }
    const first = keepShareButton("fb:share-confirm:q1", { postThrowsAt: 0 });
    await handleButton(first.interaction, shareDeps(logger, store));
    expect(first.edits).toEqual([{ content: SHARE_FAILED_MESSAGE, components: [] }]);
    expect(store.getSharedAnswer("q1")).toBeUndefined();
    expect(warns.every((w) => (w as { result?: string }).result === "post_failed")).toBe(true);
    // 再試行は成功する。
    const retry = keepShareButton("fb:share-confirm:q1");
    await handleButton(retry.interaction, shareDeps(logger, store));
    expect(store.getSharedAnswer("q1")?.messageId).toBe("m1");
  });

  it("続きのチャンクの投稿に失敗しても、先頭を投稿済みとして記録する(二重投稿させない)", async () => {
    const { logger } = fakeLogger();
    const store = setupStore({ answer: `${"あ".repeat(1500)}\n\n${"い".repeat(1500)}` });
    const b = keepShareButton("fb:share-confirm:q1", { postThrowsAt: 1 });
    await handleButton(b.interaction, shareDeps(logger, store));
    expect(b.posted).toHaveLength(1);
    expect(store.getSharedAnswer("q1")?.messageId).toBe("m1");
    expect(b.edits).toEqual([
      {
        content: shareDoneMessage("https://discord.com/channels/G/SHARE/m1", true),
        components: [],
      },
    ]);
  });
});
