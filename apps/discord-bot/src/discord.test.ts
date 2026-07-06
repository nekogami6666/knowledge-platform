import type { GhClient, PrDetail } from "@stratum/gh-client";
import type { ButtonInteraction, Message, MessageReaction, User } from "discord.js";
import { GatewayIntentBits } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { ChannelsConfig, OpsConfig } from "./config.js";
import type { BotStore } from "./db.js";
import {
  askCommand,
  BOT_INTENTS,
  type BotDeps,
  DENY_MESSAGE,
  denyReason,
  extractQuestionId,
  feedbackButtons,
  gapAnswerDecision,
  handleButton,
  handleGapAnswer,
  handleProxyMergeReaction,
  parseFeedbackCustomId,
  parseGithubPrUrl,
  proxyMergeDecision,
  windowKey,
} from "./discord.js";

/** discord.js を起動せず allowlist 配線(§9.2)の判定だけを検証する。 */
const channels = (over: Partial<ChannelsConfig> = {}): ChannelsConfig => ({
  allow: [],
  permanent_exclude: [],
  ...over,
});

describe("denyReason (§9.2 default-deny の配線)", () => {
  it("allow が空ならどのチャンネルも拒否メッセージ(default-deny)", () => {
    expect(denyReason(channels(), "111")).toBe(DENY_MESSAGE);
  });

  it("allow にあるチャンネルは null(許可 → onAsk へ進む)", () => {
    expect(denyReason(channels({ allow: ["111"] }), "111")).toBeNull();
  });

  it("permanent_exclude は allow より優先(拒否)", () => {
    expect(denyReason(channels({ allow: ["111"], permanent_exclude: ["111"] }), "111")).toBe(
      DENY_MESSAGE,
    );
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
function fakeLogger(): { logger: Logger; errors: unknown[] } {
  const errors: unknown[] = [];
  const l = {
    child: () => l,
    error: (obj: unknown) => {
      errors.push(obj);
    },
    info: () => {},
    warn: () => {},
    debug: () => {},
  };
  return { logger: l as unknown as Logger, errors };
}

function fakeStore(opts: { throwOnFeedback?: boolean } = {}): {
  store: BotStore;
  feedback: [string, string][];
  queued: unknown[];
} {
  const feedback: [string, string][] = [];
  const queued: unknown[] = [];
  const store = {
    setFeedback: (id: string, value: "up" | "down") => {
      if (opts.throwOnFeedback) throw new Error("db locked");
      feedback.push([id, value]);
    },
    queueAction: (a: unknown) => {
      queued.push(a);
    },
  };
  return { store: store as unknown as BotStore, feedback, queued };
}

function fakeButton(customId: string): { interaction: ButtonInteraction; replies: unknown[] } {
  const replies: unknown[] = [];
  const interaction = {
    customId,
    replied: false,
    deferred: false,
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

const opsOn: OpsConfig = { channel_id: "OPS", kb_repo: "org/knowledge-base" };

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
    expect(proxyMergeDecision({ ...base, ops: { channel_id: null, kb_repo: null } })).toEqual({
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

  it("gh 未設定(認証なし)は完全 no-op", async () => {
    const { logger } = fakeLogger();
    const { store, queued } = fakeStore();
    const { reaction, user, replies } = fakeReaction();
    await handleProxyMergeReaction(reaction, user, mkDeps(logger, store, undefined));
    expect(queued).toHaveLength(0);
    expect(replies).toHaveLength(0);
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
  } = {},
): { message: Message; reacted: string[] } {
  const reacted: string[] = [];
  const referenced = {
    webhookId: over.referencedWebhookId !== undefined ? over.referencedWebhookId : "WH1",
    content: over.referencedContent ?? "山田 さんが「湿度」を探していました。\n(q-2026-0007)",
  };
  const message = {
    author: { bot: over.authorBot ?? false, id: "U1" },
    reference: over.isReply === false ? null : { messageId: "REQ1" },
    content: over.content ?? "湿度が高いと Y 軸が脱調します。",
    url: "https://discord.com/channels/1/2/3",
    fetchReference: async () => {
      if (over.fetchThrows) throw new Error("unknown message");
      return referenced;
    },
    react: async (emoji: string) => {
      if (over.reactThrows) throw new Error("missing permissions");
      reacted.push(emoji);
    },
  };
  return { message: message as unknown as Message, reacted };
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
    expect(errors).toHaveLength(1);
  });
});
