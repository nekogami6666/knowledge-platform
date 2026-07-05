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
  it("exclude の basename は列挙から外す(transcript.md 除外・minutes.md は残す)", async () => {
    const exec: GitExec = async () => ({
      stdout: "mtg/2026-06-03/minutes.md\nmtg/2026-06-03/transcript.md\n",
    });
    const full = await changedMinutesFiles("/m", null, "HEAD", exec);
    expect(full).toEqual(["mtg/2026-06-03/minutes.md", "mtg/2026-06-03/transcript.md"]);
    const filtered = await changedMinutesFiles("/m", null, "HEAD", exec, ["transcript.md"]);
    expect(filtered).toEqual(["mtg/2026-06-03/minutes.md"]);
  });
  it("exclude は diff 経路にも適用される", async () => {
    const exec: GitExec = async () => ({ stdout: "a/minutes.md\na/transcript.md\n" });
    const paths = await changedMinutesFiles("/m", "old", "new", exec, ["transcript.md"]);
    expect(paths).toEqual(["a/minutes.md"]);
  });
});
