import type { Channel, ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it } from "vitest";
import { gateInputFromChannel, gateInputFromInteraction } from "./visibility.js";

function fakeChannel(over: {
  dm?: boolean;
  parentId?: string | null;
  me?: object | null;
  view?: boolean;
  permsNull?: boolean;
}): Channel {
  return {
    isDMBased: () => over.dm ?? false,
    parentId: over.parentId ?? null,
    guild: { members: { me: over.me === undefined ? {} : over.me } },
    permissionsFor: () => (over.permsNull ? null : { has: () => over.view ?? true }),
  } as unknown as Channel;
}

describe("gateInputFromChannel(message/reaction 経路・ADR-0018 D1)", () => {
  it("可視チャンネル → botCanView: true + parentId", () => {
    expect(gateInputFromChannel(fakeChannel({ parentId: "PARENT", view: true }), "CH1")).toEqual({
      channelId: "CH1",
      parentId: "PARENT",
      botCanView: true,
    });
  });

  it("不可視 → false", () => {
    expect(gateInputFromChannel(fakeChannel({ view: false }), "CH1").botCanView).toBe(false);
  });

  it("channel null / DM → 判定不能(null = 拒否側)", () => {
    expect(gateInputFromChannel(null, "CH1").botCanView).toBeNull();
    expect(gateInputFromChannel(fakeChannel({ dm: true }), "CH1").botCanView).toBeNull();
  });

  it("guild.members.me 未取得(起動直後)→ null", () => {
    expect(gateInputFromChannel(fakeChannel({ me: null }), "CH1").botCanView).toBeNull();
  });

  it("permissionsFor が null(スレッドの親未キャッシュ)→ null", () => {
    expect(gateInputFromChannel(fakeChannel({ permsNull: true }), "CH1").botCanView).toBeNull();
  });
});

describe("gateInputFromInteraction(/ask 経路・appPermissions)", () => {
  function fakeInteraction(over: { view?: boolean; channel?: object | null }) {
    return {
      channelId: "CH1",
      channel:
        over.channel === undefined ? { isDMBased: () => false, parentId: "PARENT" } : over.channel,
      appPermissions: { has: () => over.view ?? true },
    } as unknown as ChatInputCommandInteraction;
  }

  it("appPermissions を一次ソースにする(channel キャッシュ非依存)", () => {
    expect(gateInputFromInteraction(fakeInteraction({ view: true }))).toEqual({
      channelId: "CH1",
      parentId: "PARENT",
      botCanView: true,
    });
    expect(gateInputFromInteraction(fakeInteraction({ view: false })).botCanView).toBe(false);
  });

  it("channel 未キャッシュ(null)でも appPermissions で判定できる(parentId のみ不明)", () => {
    const g = gateInputFromInteraction(fakeInteraction({ view: true, channel: null }));
    expect(g).toEqual({ channelId: "CH1", parentId: null, botCanView: true });
  });
});
