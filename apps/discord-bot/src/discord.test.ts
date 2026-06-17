import { describe, expect, it } from "vitest";
import type { ChannelsConfig } from "./config.js";
import {
  DENY_MESSAGE,
  denyReason,
  feedbackButtons,
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
