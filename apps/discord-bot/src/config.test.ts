import { describe, expect, it } from "vitest";
import {
  type ChannelGateInput,
  type ChannelsConfig,
  type ConfigReader,
  isAskAllowedByRole,
  isChannelAllowed,
  isHomeChannel,
  loadChannels,
  loadDiscordIndex,
  loadOps,
  loadRepos,
  loadVoice,
} from "./config.js";

function reader(files: Record<string, string | null>): ConfigReader {
  return { read: (name) => Promise.resolve(files[name] ?? null) };
}

describe("loadRepos", () => {
  it("ファイルが無ければ空配列", async () => {
    expect((await loadRepos(reader({}))).repos).toEqual([]);
  });

  it("repo/dir/url をパースする", async () => {
    const c = await loadRepos(
      reader({
        "repos.yaml": "repos:\n  - repo: org/minutes\n    dir: minutes\n    url: https://x/y.git",
      }),
    );
    expect(c.repos).toEqual([{ repo: "org/minutes", dir: "minutes", url: "https://x/y.git" }]);
  });

  it("all_visible が無ければ null(既存 repos.yaml は従来どおり・ADR-0036 D1 既定 OFF)", async () => {
    expect((await loadRepos(reader({}))).all_visible).toBeNull();
    const c = await loadRepos(
      reader({ "repos.yaml": "repos:\n  - repo: org/minutes\n    dir: minutes" }),
    );
    expect(c).toEqual({ repos: [{ repo: "org/minutes", dir: "minutes" }], all_visible: null });
  });

  it("all_visible をパースする(exclude / sync_on_ask は既定 [])", async () => {
    const full = await loadRepos(
      reader({
        "repos.yaml": [
          "all_visible:",
          "  org: org",
          "  exclude: [secret-repo, org/other-secret]",
          "  sync_on_ask: [knowledge-base, '*-minutes']",
        ].join("\n"),
      }),
    );
    expect(full.repos).toEqual([]);
    expect(full.all_visible).toEqual({
      org: "org",
      exclude: ["secret-repo", "org/other-secret"],
      sync_on_ask: ["knowledge-base", "*-minutes"],
    });
    const minimal = await loadRepos(reader({ "repos.yaml": "all_visible:\n  org: org" }));
    expect(minimal.all_visible).toEqual({ org: "org", exclude: [], sync_on_ask: [] });
  });

  it("all_visible: null の明示は OFF・org 欠落/空は拒否", async () => {
    expect((await loadRepos(reader({ "repos.yaml": "all_visible: null" }))).all_visible).toBeNull();
    await expect(
      loadRepos(reader({ "repos.yaml": "all_visible:\n  exclude: [x]" })),
    ).rejects.toThrow();
    await expect(loadRepos(reader({ "repos.yaml": 'all_visible:\n  org: ""' }))).rejects.toThrow();
  });
});

describe("loadChannels", () => {
  it("ファイルが無ければ既定(除外なし)", async () => {
    const c = await loadChannels(reader({}));
    expect(c.permanent_exclude).toEqual([]);
    expect(c.allow).toBeUndefined();
  });

  it("yaml をパースする(旧 allow は deprecated として保持され、判定には使われない)", async () => {
    const c = await loadChannels(
      reader({ "channels.yaml": "allow: ['111']\npermanent_exclude: ['999']" }),
    );
    expect(c.allow).toEqual(["111"]); // index.ts が警告するために読むだけ
    expect(c.permanent_exclude).toEqual(["999"]);
  });
});

describe("isChannelAllowed(ADR-0018: ロール可視性 + permanent_exclude)", () => {
  const gate = (over: Partial<ChannelGateInput> = {}): ChannelGateInput => ({
    channelId: "111",
    parentId: null,
    botCanView: true,
    ...over,
  });
  const cfg = (exclude: string[] = []): ChannelsConfig => ({ permanent_exclude: exclude });

  it("bot が見える → 許可", () => {
    expect(isChannelAllowed(cfg(), gate())).toBe(true);
  });

  it("bot が見えない・判定不能(null)→ 拒否(安全側)", () => {
    expect(isChannelAllowed(cfg(), gate({ botCanView: false }))).toBe(false);
    expect(isChannelAllowed(cfg(), gate({ botCanView: null }))).toBe(false);
  });

  it("permanent_exclude は可視性より優先(拒否)", () => {
    expect(isChannelAllowed(cfg(["111"]), gate())).toBe(false);
  });

  it("スレッドは親チャンネル ID でも除外照合(ADR-0018 D3 の穴塞ぎ)", () => {
    expect(
      isChannelAllowed(cfg(["PARENT"]), gate({ channelId: "THREAD", parentId: "PARENT" })),
    ).toBe(false);
  });
});

describe("loadOps (👍 代理マージ設定・§6.3)", () => {
  it("ファイルが無ければ両方 null(機能 OFF)", async () => {
    const ops = await loadOps(reader({}));
    expect(ops).toEqual({
      channel_id: null,
      kb_repo: null,
      ask_role_ids: [],
      home_channel_ids: [],
    });
  });
  it("ops.yaml の実値を読む", async () => {
    const ops = await loadOps(
      reader({ "ops.yaml": "channel_id: '123'\nkb_repo: org/knowledge-base" }),
    );
    expect(ops).toEqual({
      channel_id: "123",
      kb_repo: "org/knowledge-base",
      ask_role_ids: [],
      home_channel_ids: [],
    });
  });
  it("片方だけの設定も許す(有効化判定は呼び出し側)", async () => {
    const ops = await loadOps(reader({ "ops.yaml": "channel_id: '123'" }));
    expect(ops.channel_id).toBe("123");
    expect(ops.kb_repo).toBeNull();
  });
  it("ask_role_ids(/ask の利用ロール・ADR-0036 D7)を読む", async () => {
    const ops = await loadOps(reader({ "ops.yaml": "ask_role_ids: ['555', '666']" }));
    expect(ops.ask_role_ids).toEqual(["555", "666"]);
  });
});

describe("isAskAllowedByRole(/ask の利用者ゲート・ADR-0036 D7)", () => {
  it("ask_role_ids が空なら誰でも通す(従来どおり)", () => {
    expect(isAskAllowedByRole([], [])).toBe(true);
    expect(isAskAllowedByRole([], null)).toBe(true);
  });
  it("いずれか 1 つのロールを持つメンバーは通す", () => {
    expect(isAskAllowedByRole(["555", "666"], ["111", "666"])).toBe(true);
    expect(isAskAllowedByRole(["555"], ["111", "555"])).toBe(true);
  });
  it("どのロールも持たないメンバーは拒否する", () => {
    expect(isAskAllowedByRole(["555", "666"], ["111"])).toBe(false);
    expect(isAskAllowedByRole(["555"], [])).toBe(false);
  });
  it("ロールが判定できない(null)なら拒否する(安全側)", () => {
    expect(isAskAllowedByRole(["555"], null)).toBe(false);
  });
});

describe("loadVoice(voice-memo / VC 録音 / interview・ADR-0015 / 0020 / 0028)", () => {
  it("ファイルが無ければ既定値(interview_arm_ttl_minutes は 120 分・ADR-0028 D5)", async () => {
    const voice = await loadVoice(reader({}));
    expect(voice.channel_id).toBeNull();
    expect(voice.max_recording_minutes).toBe(15);
    expect(voice.interview_arm_ttl_minutes).toBe(120);
  });

  it("voice.yaml の実値を読む(不正値は reject)", async () => {
    const voice = await loadVoice(
      reader({ "voice.yaml": "vc_channel_id: '222'\ninterview_arm_ttl_minutes: 30" }),
    );
    expect(voice.vc_channel_id).toBe("222");
    expect(voice.interview_arm_ttl_minutes).toBe(30);
    await expect(
      loadVoice(reader({ "voice.yaml": "interview_arm_ttl_minutes: 0" })),
    ).rejects.toThrow();
  });
});

describe("loadDiscordIndex(ADR-0038 D9)", () => {
  it("ファイルが無ければ既定値(enabled: false = 機能 OFF)", async () => {
    expect(await loadDiscordIndex(reader({}))).toEqual({
      enabled: false,
      backfill_days: 90,
      retention_days: 180,
      reconcile_interval_hours: 6,
      reconcile_window_days: 7,
      max_results: 8,
      excerpt_chars: 200,
      max_tool_calls: 1,
      max_fetch_per_channel: 10_000,
    });
  });

  it("部分指定は既定値で補う", async () => {
    const c = await loadDiscordIndex(
      reader({ "discord-index.yaml": "enabled: true\nretention_days: 120" }),
    );
    expect(c.enabled).toBe(true);
    expect(c.retention_days).toBe(120);
    expect(c.backfill_days).toBe(90);
  });

  it("保持期間が初回取り込みより短い・照合範囲が保持期間より長い設定は拒否する", async () => {
    await expect(
      loadDiscordIndex(reader({ "discord-index.yaml": "retention_days: 30" })),
    ).rejects.toThrow();
    await expect(
      loadDiscordIndex(
        reader({
          "discord-index.yaml": "backfill_days: 7\nretention_days: 10\nreconcile_window_days: 11",
        }),
      ),
    ).rejects.toThrow();
  });

  it("max_tool_calls は 0〜5(0 = ツールを渡さない)・excerpt_chars は 80〜500(ADR-0038 追記 2026-10-08)", async () => {
    const zero = await loadDiscordIndex(reader({ "discord-index.yaml": "max_tool_calls: 0" }));
    expect(zero.max_tool_calls).toBe(0);
    for (const bad of [
      "max_tool_calls: -1",
      "max_tool_calls: 6",
      "max_tool_calls: 1.5",
      "excerpt_chars: 79",
      "excerpt_chars: 501",
      "max_results: 0",
      "max_results: 101",
    ]) {
      await expect(loadDiscordIndex(reader({ "discord-index.yaml": bad })), bad).rejects.toThrow();
    }
  });
});

describe("isHomeChannel(ops.home_channel_ids・2026-10-07)", () => {
  it("空なら全チャンネルを通す(従来どおり)", () => {
    expect(isHomeChannel([], { channelId: "X", parentId: null })).toBe(true);
  });
  it("一致するチャンネル、または親チャンネルが一致するスレッドだけを通す", () => {
    expect(isHomeChannel(["HOME"], { channelId: "HOME", parentId: null })).toBe(true);
    expect(isHomeChannel(["HOME"], { channelId: "T1", parentId: "HOME" })).toBe(true);
    expect(isHomeChannel(["HOME"], { channelId: "OTHER", parentId: null })).toBe(false);
    expect(isHomeChannel(["HOME"], { channelId: "T2", parentId: "OTHER" })).toBe(false);
  });
  it("ops.yaml の home_channel_ids を読む(既定は空)", async () => {
    expect((await loadOps(reader({}))).home_channel_ids).toEqual([]);
    const ops = await loadOps(reader({ "ops.yaml": "home_channel_ids: ['111']" }));
    expect(ops.home_channel_ids).toEqual(["111"]);
  });
});
