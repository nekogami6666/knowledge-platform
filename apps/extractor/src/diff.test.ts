import { describe, expect, it } from "vitest";
import { changedMinutesFiles, type GitExec } from "./diff.js";

describe("changedMinutesFiles", () => {
  it("sinceSha=null は ls-files で全 md を列挙", async () => {
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      return { stdout: "2026/06/a.md\n2026/06/b.md\n" };
    };
    const paths = await changedMinutesFiles("/m", null, "HEAD", exec);
    expect(paths).toEqual(["2026/06/a.md", "2026/06/b.md"]);
    expect(calls[0]).toEqual(["ls-files", "*.md"]);
  });
  it("sinceSha 有りは diff --name-only(範囲付き)", async () => {
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      return { stdout: "2026/06/c.md\n" };
    };
    const paths = await changedMinutesFiles("/m", "old", "new", exec);
    expect(paths).toEqual(["2026/06/c.md"]);
    expect(calls[0]).toContain("old..new");
  });
});
