import { describe, expect, it } from "vitest";
import { buildPermalinkIndex } from "./prefilter.js";

describe("buildPermalinkIndex", () => {
  it("knowledge/decisions/questions の *.md から discord permalink を集める", async () => {
    const files: Record<string, string[]> = {
      "/kb/knowledge": ["hardware/kb-2026-aaaaaa-foo.md"],
      "/kb/decisions": ["2026/dr-2026-bbbbbb-bar.md"],
      "/kb/questions": [],
    };
    const contents: Record<string, string> = {
      "/kb/knowledge/hardware/kb-2026-aaaaaa-foo.md":
        "出典: https://discord.com/channels/100/200/300 と本文中の https://discord.com/channels/100/200/301",
      "/kb/decisions/2026/dr-2026-bbbbbb-bar.md":
        "sources:\n  - https://discord.com/channels/100/200/302\ngithub は https://github.com/org/kb/pull/1",
    };
    const index = await buildPermalinkIndex("/kb", {
      listFiles: async (dir) => files[dir] ?? [],
      readFile: async (p) => contents[p] ?? "",
    });
    expect(index).toEqual(
      new Set([
        "https://discord.com/channels/100/200/300",
        "https://discord.com/channels/100/200/301",
        "https://discord.com/channels/100/200/302",
      ]),
    );
  });

  it("md 以外は読まない・permalink 無しは空 Set", async () => {
    const read: string[] = [];
    const index = await buildPermalinkIndex("/kb", {
      listFiles: async (dir) => (dir === "/kb/knowledge" ? ["image.png", "note.md"] : []),
      readFile: async (p) => {
        read.push(p);
        return "permalink なし";
      },
    });
    expect(read).toEqual(["/kb/knowledge/note.md"]);
    expect(index.size).toBe(0);
  });
});
