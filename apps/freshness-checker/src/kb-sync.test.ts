import { describe, expect, it } from "vitest";
import { type GitExec, stripCredentials, syncKb } from "./kb-sync.js";

const TOKEN_URL = "https://x-access-token:SECRET@github.com/org/knowledge-base.git";
const CLEAN_URL = "https://github.com/org/knowledge-base.git";

/** exec 記録 fake。existing=false は --git-dir probe を throw(未 clone)、true は独立リポ(".git")。 */
function fakeExec(existing: boolean): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--git-dir") {
      if (!existing) throw new Error("not a repo");
      return { stdout: ".git\n" };
    }
    return { stdout: "abc123\n" };
  };
  return { exec, calls };
}

describe("stripCredentials", () => {
  it("userinfo を除去する", () => {
    expect(stripCredentials(TOKEN_URL)).toBe(CLEAN_URL);
    expect(stripCredentials(CLEAN_URL)).toBe(CLEAN_URL);
  });
});

describe("syncKb(トークン非永続化・ADR-0013 D1(b) と同流儀)", () => {
  it("新規 clone 後に remote URL をトークン無しへ差し替える", async () => {
    const { exec, calls } = fakeExec(false);
    const r = await syncKb(
      { dir: "knowledge-base", url: TOKEN_URL, baseBranch: "main" },
      "/c",
      exec,
    );
    expect(r.resolvedCommit).toBe("abc123");
    expect(calls.some((a) => a[0] === "clone")).toBe(true);
    expect(calls).toContainEqual(["remote", "set-url", "origin", CLEAN_URL]);
  });
  it("既存 clone + url は URL 引数 fetch + FETCH_HEAD reset", async () => {
    const { exec, calls } = fakeExec(true);
    await syncKb({ dir: "knowledge-base", url: TOKEN_URL, baseBranch: "main" }, "/c", exec);
    expect(calls).toContainEqual(["fetch", TOKEN_URL, "main"]);
    expect(calls).toContainEqual(["reset", "--hard", "FETCH_HEAD"]);
  });
  it("url 無し・clone 未存在は throw", async () => {
    const { exec } = fakeExec(false);
    await expect(syncKb({ dir: "kb", baseBranch: "main" }, "/c", exec)).rejects.toThrow();
  });
  it("親リポの内側(--git-dir が ../.git)は fetch/reset/clone せず throw(親リポ破壊防止)", async () => {
    // --is-inside-work-tree 判定は親リポの内側でも true になり reset --hard が親を破壊した
    // (VM 実害 2026-07-17)。--git-dir が相対 ".git" 以外なら独立リポでないとして fail-loud。
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { stdout: "../.git\n" };
      return { stdout: "abc123\n" };
    };
    await expect(
      syncKb({ dir: "knowledge-base", url: TOKEN_URL, baseBranch: "main" }, "/c", exec),
    ).rejects.toThrow(/独立した git リポではありません/);
    expect(calls.some((a) => a[0] === "fetch" || a[0] === "reset" || a[0] === "clone")).toBe(false);
  });
});
