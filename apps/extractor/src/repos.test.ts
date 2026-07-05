import { describe, expect, it } from "vitest";
import type { ExtractorConfig } from "./config.js";
import type { GitExec } from "./diff.js";
import { createGitRepoSyncer, stripCredentials } from "./repos.js";

const TOKEN_URL = "https://x-access-token:SECRET@github.com/org/minutes.git";
const CLEAN_URL = "https://github.com/org/minutes.git";

const config = (minutesUrl?: string): ExtractorConfig => ({
  minutes: {
    repo: "org/minutes",
    dir: "minutes",
    exclude: ["transcript.md"],
    ...(minutesUrl !== undefined ? { url: minutesUrl } : {}),
  },
  kb: { repo: "org/knowledge-base", dir: "knowledge-base" },
  base_branch: "main",
});

/** exec 呼び出しを記録する fake。existingDirs に無い dir の rev-parse --is-inside-work-tree は throw。 */
function fakeExec(existingDirs: string[]): { exec: GitExec; calls: [string[], string][] } {
  const calls: [string[], string][] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push([[...args], cwd]);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      if (!existingDirs.some((d) => cwd.endsWith(d))) throw new Error("not a repo");
    }
    return { stdout: "abc123\n" };
  };
  return { exec, calls };
}

describe("stripCredentials", () => {
  it("https URL の userinfo(user:token@)を除去する", () => {
    expect(stripCredentials(TOKEN_URL)).toBe(CLEAN_URL);
    expect(stripCredentials("https://TOKEN@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });
  it("認証情報が無い URL はそのまま", () => {
    expect(stripCredentials(CLEAN_URL)).toBe(CLEAN_URL);
  });
});

describe("createGitRepoSyncer(トークン非永続化・ADR-0013)", () => {
  it("新規 clone 後に remote URL をトークン無しへ差し替える", async () => {
    const { exec, calls } = fakeExec(["knowledge-base"]); // minutes は未 clone
    await createGitRepoSyncer(config(TOKEN_URL), "/c", exec).sync();
    const minuteCalls = calls.filter(([, cwd]) => cwd.includes("minutes") || cwd === "/c");
    expect(minuteCalls.map(([a]) => a[0])).toContain("clone");
    const setUrl = calls.find(([a]) => a[0] === "remote" && a[1] === "set-url");
    expect(setUrl?.[0]).toEqual(["remote", "set-url", "origin", CLEAN_URL]);
  });

  it("既存 clone + url は URL 引数で fetch し FETCH_HEAD に reset(origin 設定に依存しない)", async () => {
    const { exec, calls } = fakeExec(["minutes", "knowledge-base"]);
    await createGitRepoSyncer(config(TOKEN_URL), "/c", exec).sync();
    const fetch = calls.find(([a]) => a[0] === "fetch");
    expect(fetch?.[0]).toEqual(["fetch", TOKEN_URL, "main"]);
    const reset = calls.find(([a]) => a[0] === "reset");
    expect(reset?.[0]).toEqual(["reset", "--hard", "FETCH_HEAD"]);
  });

  it("url 無しの既存 dir は fetch/clone せず rev-parse のみ", async () => {
    const { exec, calls } = fakeExec(["minutes", "knowledge-base"]);
    const r = await createGitRepoSyncer(config(undefined), "/c", exec).sync();
    expect(r.minutes.resolvedCommit).toBe("abc123");
    expect(calls.some(([a]) => a[0] === "fetch" || a[0] === "clone")).toBe(false);
  });
});
