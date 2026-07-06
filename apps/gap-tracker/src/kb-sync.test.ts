import { describe, expect, it } from "vitest";
import { type GitExec, stripCredentials, syncKb } from "./kb-sync.js";

const TOKEN_URL = "https://x-access-token:SECRET@github.com/org/knowledge-base.git";
const CLEAN_URL = "https://github.com/org/knowledge-base.git";

function fakeExec(existing: boolean): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree" && !existing) {
      throw new Error("not a repo");
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
});
