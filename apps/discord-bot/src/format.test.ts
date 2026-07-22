import { describe, expect, it } from "vitest";
import type { ResolvedCitation } from "./ask.js";
import { citationUrl, formatAnswer, STALE_NOTE, sanitizeAnswerBody } from "./format.js";

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

  it("モデルが本文に書いた自前の出典ブロック(宙ぶらりん [3] 不明 を含む)を除去し、脚注は検証済みのみで採番する", () => {
    const answer =
      "高湿度で Y 軸が脱調する。\n\n出典:\n[1] https://x/06-03\n[2] https://x/06-10\n[3] 不明";
    const citations: ResolvedCitation[] = [
      {
        kind: "github_file",
        repo: "org/minutes",
        path: "2026/06/06-03.md",
        ref: "sha1",
        lines: "L6-L10",
      },
      {
        kind: "github_file",
        repo: "org/minutes",
        path: "2026/06/06-10.md",
        ref: "sha2",
        lines: "L5-L8",
      },
    ];
    const out = formatAnswer(answer, citations);
    expect(out).not.toContain("不明");
    expect(out).not.toContain("[3]");
    expect(out.match(/出典:/g)?.length).toBe(1); // 本文の自前ブロックが消え、脚注は1つだけ
    expect(out.startsWith("高湿度で Y 軸が脱調する。")).toBe(true);
    expect(out).toContain("[1] https://github.com/org/minutes/blob/sha1/2026/06/06-03.md#L6-L10");
    expect(out).toContain("[2] https://github.com/org/minutes/blob/sha2/2026/06/06-10.md#L5-L8");
  });
});

describe("sanitizeAnswerBody", () => {
  it("見出し付きの末尾出典ブロックを除去する", () => {
    expect(sanitizeAnswerBody("本文。\n\n出典:\n[1] a\n[2] b")).toBe("本文。");
  });

  it("『参考』見出し・同一行の [N] も除去する", () => {
    expect(sanitizeAnswerBody("本文。\n参考: [1] a")).toBe("本文。");
  });

  it("見出し無しの末尾 [N] 行の連なりを除去する", () => {
    expect(sanitizeAnswerBody("本文。\n[1] a\n[2] b")).toBe("本文。");
  });

  it("散文中のインライン [N] は保持する", () => {
    expect(sanitizeAnswerBody("手順[1]を実施し、次に[2]を確認する。")).toBe(
      "手順[1]を実施し、次に[2]を確認する。",
    );
  });

  it("『参考にしてください。』のような散文は誤除去しない", () => {
    expect(sanitizeAnswerBody("本文。\n詳細は上記を参考にしてください。")).toBe(
      "本文。\n詳細は上記を参考にしてください。",
    );
  });

  it("出典が無ければ trimEnd のみ", () => {
    expect(sanitizeAnswerBody("答え\n")).toBe("答え");
  });
});
