import { describe, expect, it } from "vitest";
import { changedSourceFiles, type GitExec } from "./diff.js";

describe("changedSourceFiles", () => {
  it("sinceSha=null は ls-files(pathspec 付き)で全件を列挙", async () => {
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      return { stdout: "2026/06/a.md\n2026/06/b.md\n" };
    };
    const paths = await changedSourceFiles("/m", null, "HEAD", exec, { pathspec: "*.md" });
    expect(paths).toEqual(["2026/06/a.md", "2026/06/b.md"]);
    expect(calls[0]).toEqual(["ls-files", "*.md"]);
  });
  it("sinceSha 有りは diff --name-only(範囲 + pathspec 付き)", async () => {
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      return { stdout: "interviews/2026/c.md\n" };
    };
    const paths = await changedSourceFiles("/kb", "old", "new", exec, {
      pathspec: "interviews/*.md",
    });
    expect(paths).toEqual(["interviews/2026/c.md"]);
    expect(calls[0]).toContain("old..new");
    expect(calls[0]).toContain("interviews/*.md");
  });
  it("excludeBasenames は列挙から外す(transcript.md 除外・minutes.md は残す)", async () => {
    const exec: GitExec = async () => ({
      stdout: "mtg/2026-06-03/minutes.md\nmtg/2026-06-03/transcript.md\n",
    });
    const full = await changedSourceFiles("/m", null, "HEAD", exec, { pathspec: "*.md" });
    expect(full).toEqual(["mtg/2026-06-03/minutes.md", "mtg/2026-06-03/transcript.md"]);
    const filtered = await changedSourceFiles("/m", null, "HEAD", exec, {
      pathspec: "*.md",
      excludeBasenames: ["transcript.md"],
    });
    expect(filtered).toEqual(["mtg/2026-06-03/minutes.md"]);
  });
  it("excludeDirs は配下を丸ごと外す(kits/ と voice-memos/・PR-I1)", async () => {
    const exec: GitExec = async () => ({
      stdout: [
        "interviews/2026-07-01-yamada.md",
        "interviews/kits/yamada-hardware.md",
        "interviews/voice-memos/2026-07-01.md",
      ].join("\n"),
    });
    const paths = await changedSourceFiles("/kb", "old", "new", exec, {
      pathspec: "interviews/*.md",
      excludeDirs: ["interviews/kits", "interviews/voice-memos"],
    });
    expect(paths).toEqual(["interviews/2026-07-01-yamada.md"]);
  });
});
