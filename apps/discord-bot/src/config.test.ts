import { describe, expect, it } from "vitest";
import {
  type ChannelGateInput,
  type ChannelsConfig,
  type ConfigReader,
  isChannelAllowed,
  loadChannels,
  loadOps,
  loadRepos,
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
    expect(ops).toEqual({ channel_id: null, kb_repo: null });
  });
  it("ops.yaml の実値を読む", async () => {
    const ops = await loadOps(
      reader({ "ops.yaml": "channel_id: '123'\nkb_repo: org/knowledge-base" }),
    );
    expect(ops).toEqual({ channel_id: "123", kb_repo: "org/knowledge-base" });
  });
  it("片方だけの設定も許す(有効化判定は呼び出し側)", async () => {
    const ops = await loadOps(reader({ "ops.yaml": "channel_id: '123'" }));
    expect(ops.channel_id).toBe("123");
    expect(ops.kb_repo).toBeNull();
  });
});
