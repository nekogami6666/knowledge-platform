import type { GhClient, PrDetail } from "@stratum/gh-client";
import type { ButtonInteraction, MessageReaction, User } from "discord.js";
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
  feedbackButtons,
  handleButton,
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
  it("Guilds + リアクション + MessageContent(👍 代理マージ・§6.3)。GuildMessages は要求しない", () => {
    // MessageContent は privileged だが、webhook 通知の本文から PR URL を読むために必要
    // (§9.2 L620 が Portal での有効化を想定済み)。メッセージ作成イベント自体は購読しない。
    expect([...BOT_INTENTS]).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ]);
    expect([...BOT_INTENTS]).not.toContain(GatewayIntentBits.GuildMessages);
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

/** handleProxyMergeReaction 用の最小 fake(webhook 通知メッセージ + 人間のリアクション)。 */
function fakeReaction(
  over: {
    emoji?: string | null;
    channelId?: string;
    webhookId?: string | null;
    content?: string;
    userBot?: boolean;
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
