import { describe, expect, it } from "vitest";
import { discordSourceConfigSchema, loadDiscordSourceConfig, rotateChannels } from "./config.js";

describe("discordSourceConfigSchema", () => {
  it("targets 既定は空(= 機能 OFF)で caps に既定値が入る", () => {
    const c = discordSourceConfigSchema.parse({ kb: { repo: "org/kb" } });
    expect(c.targets).toEqual([]);
    expect(c.kb.dir).toBe("knowledge-base");
    expect(c.base_branch).toBe("main");
    expect(c.backfill_days).toBe(90);
    expect(c.max_channels).toBe(2);
    expect(c.max_messages_per_channel).toBe(200);
    expect(c.max_extract_calls).toBe(8);
    expect(c.max_entries_per_run).toBe(10);
    expect(c.window_gap_minutes).toBe(30);
    expect(c.window_max_messages).toBe(50);
    expect(c.review_mentions).toEqual([]);
    expect(c.all_visible).toBe(false);
    expect(c.exclude).toEqual([]);
  });

  it("all_visible と exclude を受け付ける", () => {
    const c = discordSourceConfigSchema.parse({
      kb: { repo: "org/kb" },
      all_visible: true,
      exclude: ["999"],
    });
    expect(c.all_visible).toBe(true);
    expect(c.exclude).toEqual(["999"]);
  });

  it("未知キーは strict で拒否する", () => {
    expect(() =>
      discordSourceConfigSchema.parse({ kb: { repo: "org/kb" }, unknown_key: 1 }),
    ).toThrow();
  });

  it("kb.repo が無ければ拒否する", () => {
    expect(() => discordSourceConfigSchema.parse({})).toThrow();
  });
});

describe("loadDiscordSourceConfig", () => {
  it("discord.yaml を読んで parse する", async () => {
    const cfg = await loadDiscordSourceConfig({
      read: async (name) => {
        expect(name).toBe("discord.yaml");
        return 'targets: ["111"]\nkb:\n  repo: org/kb\nmax_channels: 1\n';
      },
    });
    expect(cfg.targets).toEqual(["111"]);
    expect(cfg.max_channels).toBe(1);
  });
});

describe("rotateChannels", () => {
  const ids = ["a", "b", "c"];

  it("日インデックスで起点が回る(同日内は安定)", () => {
    const day0 = new Date(0); // epoch 日 0 → start 0
    expect(rotateChannels(ids, day0)).toEqual(["a", "b", "c"]);
    const day1 = new Date(86_400_000); // 翌日 → start 1
    expect(rotateChannels(ids, day1)).toEqual(["b", "c", "a"]);
    const day2 = new Date(2 * 86_400_000);
    expect(rotateChannels(ids, day2)).toEqual(["c", "a", "b"]);
  });

  it("要素 1 以下はそのまま返す", () => {
    expect(rotateChannels([], new Date())).toEqual([]);
    expect(rotateChannels(["x"], new Date())).toEqual(["x"]);
  });
});
