import { describe, expect, it } from "vitest";
import {
  type ConfigReader,
  githubForDiscord,
  isChannelAllowed,
  loadChannels,
  loadMembers,
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
  it("ファイルが無ければ default-deny の空設定", async () => {
    const c = await loadChannels(reader({}));
    expect(c.allow).toEqual([]);
    expect(c.permanent_exclude).toEqual([]);
  });

  it("yaml をパースする", async () => {
    const c = await loadChannels(
      reader({ "channels.yaml": "allow: ['111']\npermanent_exclude: ['999']" }),
    );
    expect(c.allow).toEqual(["111"]);
    expect(c.permanent_exclude).toEqual(["999"]);
  });
});

describe("isChannelAllowed (§9.2 default-deny)", () => {
  it("allow が空ならどのチャンネルも拒否", () => {
    expect(isChannelAllowed({ allow: [], permanent_exclude: [] }, "111")).toBe(false);
  });

  it("allow にあれば許可", () => {
    expect(isChannelAllowed({ allow: ["111"], permanent_exclude: [] }, "111")).toBe(true);
  });

  it("permanent_exclude が allow より優先(拒否)", () => {
    expect(isChannelAllowed({ allow: ["111"], permanent_exclude: ["111"] }, "111")).toBe(false);
  });
});

describe("githubForDiscord", () => {
  it("マップがあれば GitHub 名、無ければ undefined", async () => {
    const m = await loadMembers(
      reader({ "members.yaml": "members:\n  - github: yamada\n    discord: '123'" }),
    );
    expect(githubForDiscord(m, "123")).toBe("yamada");
    expect(githubForDiscord(m, "999")).toBeUndefined();
  });
});
