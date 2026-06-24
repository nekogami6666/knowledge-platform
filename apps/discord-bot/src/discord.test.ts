import type { ButtonInteraction } from "discord.js";
import { GatewayIntentBits } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import type { ChannelsConfig } from "./config.js";
import type { BotStore } from "./db.js";
import {
  askCommand,
  BOT_INTENTS,
  type BotDeps,
  DENY_MESSAGE,
  denyReason,
  feedbackButtons,
  handleButton,
  parseFeedbackCustomId,
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
  it("Guilds のみ。privileged な MessageContent は要求しない", () => {
    expect([...BOT_INTENTS]).toEqual([GatewayIntentBits.Guilds]);
    expect([...BOT_INTENTS]).not.toContain(GatewayIntentBits.MessageContent);
  });
});
