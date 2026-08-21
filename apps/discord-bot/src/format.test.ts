import { describe, expect, it } from "vitest";
import type { ResolvedCitation } from "./ask.js";
import {
  citationUrl,
  DISCORD_MESSAGE_LIMIT,
  formatAnswer,
  STALE_NOTE,
  sanitizeAnswerBody,
  splitForDiscord,
} from "./format.js";

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

describe("splitForDiscord", () => {
  /** 全ケース共通の不変条件: 各チャンクは非空かつ limit 以下。 */
  function assertInvariants(chunks: string[], limit: number): void {
    for (const c of chunks) {
      expect(c).not.toBe("");
      expect(c.length).toBeLessThanOrEqual(limit);
    }
  }

  it("空文字列は []", () => {
    expect(splitForDiscord("")).toEqual([]);
  });

  it("ちょうど上限(2000字)は単一チャンク", () => {
    const text = "あ".repeat(DISCORD_MESSAGE_LIMIT);
    expect(splitForDiscord(text)).toEqual([text]);
  });

  it("2001字(改行なし)は 2 分割され join で復元できる", () => {
    const text = "a".repeat(DISCORD_MESSAGE_LIMIT + 1);
    const chunks = splitForDiscord(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(chunks.join("")).toBe(text);
    assertInvariants(chunks, DISCORD_MESSAGE_LIMIT);
  });

  it("段落境界を優先して分割し、区切りの \\n\\n はどちらのチャンクにも残らない", () => {
    const body = "本文。".repeat(5); // 15字
    const notes = "[1] https://example.com/a\n[2] https://example.com/b";
    const text = `${body}\n\n出典:\n${notes}`;
    const chunks = splitForDiscord(text, 30);
    expect(chunks[0]).toBe(body);
    expect(chunks[1]?.startsWith("出典:")).toBe(true);
    for (const c of chunks) expect(c).not.toContain("\n\n");
    assertInvariants(chunks, 30);
  });

  it("窓内に段落境界が無ければ行境界で分割し、区切りの \\n は残らない", () => {
    const lines = ["1234567890", "abcdefghij", "ABCDEFGHIJ"];
    const chunks = splitForDiscord(lines.join("\n"), 25);
    expect(chunks).toEqual([`${lines[0]}\n${lines[1]}`, lines[2]]);
    assertInvariants(chunks, 25);
  });

  it("改行の無い長文は強制カットのみで、join で完全に復元できる", () => {
    const text = "x".repeat(5001);
    const chunks = splitForDiscord(text, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe(text);
    assertInvariants(chunks, 2000);
  });

  it("末尾が区切りでも空チャンクを出さない", () => {
    const text = `${"a".repeat(10)}\n\n`;
    const chunks = splitForDiscord(text, 11);
    expect(chunks).toEqual(["a".repeat(10)]);
  });

  it("先頭の区切りでは空チャンクを出さない(次の優先度へ落ちる)", () => {
    const text = `\n${"a".repeat(30)}`;
    const chunks = splitForDiscord(text, 20);
    expect(chunks[0]).not.toBe("");
    expect(chunks.join("")).toBe(text);
    assertInvariants(chunks, 20);
  });

  it("実インシデント形状(和文約3000字 + URL 7行)では URL 行が必ず 1 チャンク内に収まる", () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `第${i + 1}段落。${"検証".repeat(120)}`,
    );
    const notes = Array.from(
      { length: 7 },
      (_, i) =>
        `[${i + 1}] https://github.com/org/repo/blob/3392107adb2aa2b32208e39f13adb2ac19d6adb5/knowledge/some/long/path-${i + 1}.md#L10-L20`,
    );
    const text = `${paragraphs.join("\n\n")}\n\n出典:\n${notes.join("\n")}`;
    expect(text.length).toBeGreaterThan(DISCORD_MESSAGE_LIMIT);
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const note of notes) {
      expect(chunks.filter((c) => c.includes(note))).toHaveLength(1);
    }
    assertInvariants(chunks, DISCORD_MESSAGE_LIMIT);
  });

  it("強制カットでサロゲートペアを分断しない(境界を 1 文字手前に退避)", () => {
    // 😀 (U+1F600) は UTF-16 で 2 単位。limit 5 だと 3 文字目の絵文字の途中が境界になる。
    const text = "ab😀😀cd";
    const chunks = splitForDiscord(text, 5);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) {
      expect(c).not.toMatch(/^[\uDC00-\uDFFF]/); // 下位サロゲート開始 = ペア分断
      expect(c).not.toMatch(/[\uD800-\uDBFF]$/); // 上位サロゲート終端 = ペア分断
    }
    assertInvariants(chunks, 5);
  });

  it("limit 引数を指定できる", () => {
    const chunks = splitForDiscord("abcdef", 2);
    expect(chunks).toEqual(["ab", "cd", "ef"]);
  });
});
