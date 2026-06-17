import { describe, expect, it } from "vitest";
import type { ChannelsConfig } from "./config.js";
import { DENY_MESSAGE, denyReason } from "./discord.js";

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
