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
  interviews: { dir: "interviews", exclude_dirs: ["kits", "voice-memos"] },
  base_branch: "main",
});

/** exec 記録 fake。existingDirs に無い dir の --git-dir probe は throw、ある dir は独立リポ(".git")。 */
function fakeExec(existingDirs: string[]): { exec: GitExec; calls: [string[], string][] } {
  const calls: [string[], string][] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push([[...args], cwd]);
    if (args[0] === "rev-parse" && args[1] === "--git-dir") {
      if (!existingDirs.some((d) => cwd.endsWith(d))) throw new Error("not a repo");
      return { stdout: ".git\n" };
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

  it("既存 clone + url は URL 引数で fetch し FETCH_HEAD に reset + 未追跡残骸を clean", async () => {
    const { exec, calls } = fakeExec(["minutes", "knowledge-base"]);
    await createGitRepoSyncer(config(TOKEN_URL), "/c", exec).sync();
    const fetch = calls.find(([a]) => a[0] === "fetch");
    expect(fetch?.[0]).toEqual(["fetch", TOKEN_URL, "main"]);
    const reset = calls.find(([a]) => a[0] === "reset");
    expect(reset?.[0]).toEqual(["reset", "--hard", "FETCH_HEAD"]);
    // reset --hard は未追跡ファイルを消さないため、dry-run staging の残骸は clean で除去する。
    const resetIdx = calls.findIndex(([a]) => a[0] === "reset");
    const cleanIdx = calls.findIndex(([a]) => a[0] === "clean");
    expect(calls[cleanIdx]?.[0]).toEqual(["clean", "-fd"]);
    expect(cleanIdx).toBeGreaterThan(resetIdx);
  });

  it("url 無しの既存 dir は fetch/clone/reset/clean せず rev-parse のみ(未 commit 作業を破壊しない)", async () => {
    const { exec, calls } = fakeExec(["minutes", "knowledge-base"]);
    const r = await createGitRepoSyncer(config(undefined), "/c", exec).sync();
    expect(r.minutes.resolvedCommit).toBe("abc123");
    // clean は破壊的。url 無し(開発者の事前 checkout)では未 commit 作業がありうるため走らせない。
    expect(
      calls.some(
        ([a]) => a[0] === "fetch" || a[0] === "clone" || a[0] === "reset" || a[0] === "clean",
      ),
    ).toBe(false);
  });

  it("親リポの内側(--git-dir が ../.git)は fetch/reset/clone せず throw(親リポ破壊防止)", async () => {
    // --is-inside-work-tree 判定は親リポの内側でも true になり reset --hard が親を破壊した
    // (VM 実害 2026-07-17)。--git-dir が相対 ".git" 以外なら独立リポでないとして fail-loud。
    const calls: [string[], string][] = [];
    const exec: GitExec = async (args, cwd) => {
      calls.push([[...args], cwd]);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { stdout: "../../.git\n" };
      return { stdout: "abc123\n" };
    };
    await expect(createGitRepoSyncer(config(TOKEN_URL), "/c", exec).sync()).rejects.toThrow(
      /独立した git リポではありません/,
    );
    expect(
      calls.some(
        ([a]) => a[0] === "fetch" || a[0] === "reset" || a[0] === "clean" || a[0] === "clone",
      ),
    ).toBe(false);
  });
});
