import { describe, expect, it } from "vitest";
import type { ResolvedCitation } from "./ask.js";
import { citationUrl, formatAnswer, STALE_NOTE } from "./format.js";

describe("citationUrl (commit-SHA permalink)", () => {
  it("github_file は blob/<SHA>/path#行アンカー", () => {
    expect(
      citationUrl({
        kind: "github_file",
        repo: "org/minutes",
        path: "2026/06/x.md",
        ref: "abc123",
        lines: "L10-L20",
      }),
    ).toBe("https://github.com/org/minutes/blob/abc123/2026/06/x.md#L10-L20");
  });

  it("github_file は lines 無しでも可(SHA 固定)", () => {
    expect(citationUrl({ kind: "github_file", repo: "org/r", path: "a.md", ref: "deadbeef" })).toBe(
      "https://github.com/org/r/blob/deadbeef/a.md",
    );
  });

  it("github_pr / github_issue", () => {
    expect(citationUrl({ kind: "github_pr", repo: "org/r", number: 12 })).toBe(
      "https://github.com/org/r/pull/12",
    );
    expect(citationUrl({ kind: "github_issue", repo: "org/r", number: 7 })).toBe(
      "https://github.com/org/r/issues/7",
    );
  });

  it("discord はそのまま url", () => {
    const url = "https://discord.com/channels/1/2/3";
    expect(citationUrl({ kind: "discord", url })).toBe(url);
  });
});

describe("formatAnswer", () => {
  it("出典脚注を付す", () => {
    const citations: ResolvedCitation[] = [
      { kind: "github_file", repo: "org/r", path: "a.md", ref: "sha1", lines: "L1" },
      { kind: "discord", url: "https://discord.com/channels/1/2/3" },
    ];
    const out = formatAnswer("答え", citations);
    expect(out).toContain("答え");
    expect(out).toContain("出典:");
    expect(out).toContain("[1] https://github.com/org/r/blob/sha1/a.md#L1");
    expect(out).toContain("[2] https://discord.com/channels/1/2/3");
  });

  it("引用が無ければ本文のみ", () => {
    expect(formatAnswer("答え", [])).toBe("答え");
  });

  it("stale な KB 引用には注記を付す(§6.7 / C8。他の引用には付けない)", () => {
    const citations: ResolvedCitation[] = [
      { kind: "github_file", repo: "org/kb", path: "knowledge/x.md", ref: "sha1", stale: true },
      { kind: "github_file", repo: "org/kb", path: "knowledge/y.md", ref: "sha1" },
    ];
    const out = formatAnswer("答え", citations);
    expect(out).toContain(`[1] https://github.com/org/kb/blob/sha1/knowledge/x.md ${STALE_NOTE}`);
    expect(out).toContain("[2] https://github.com/org/kb/blob/sha1/knowledge/y.md");
    expect(out.split("\n").at(-1)).not.toContain(STALE_NOTE);
  });
});
