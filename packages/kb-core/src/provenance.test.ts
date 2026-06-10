import { describe, expect, it } from "vitest";
import { KbProvenanceError } from "./errors.js";
import { parseLineRange, sourceToUrl, urlToSource } from "./provenance.js";
import type { Source } from "./schemas/source.js";

describe("sourceToUrl", () => {
  it("discord はそのまま url を返す", () => {
    const s: Source = { kind: "discord", url: "https://discord.com/channels/1/2/3" };
    expect(sourceToUrl(s)).toBe("https://discord.com/channels/1/2/3");
  });

  it("pr / issue を GitHub URL に変換する", () => {
    expect(sourceToUrl({ kind: "pr", repo: "org/app", number: 12 })).toBe(
      "https://github.com/org/app/pull/12",
    );
    expect(sourceToUrl({ kind: "issue", repo: "org/app", number: 7 })).toBe(
      "https://github.com/org/app/issues/7",
    );
  });

  it("ファイル source を blob URL + 行アンカーに変換する", () => {
    expect(
      sourceToUrl({
        kind: "meeting",
        repo: "org/minutes",
        path: "2026/a.md",
        lines: "L120-L141",
        ref: "abc123",
      }),
    ).toBe("https://github.com/org/minutes/blob/abc123/2026/a.md#L120-L141");
    // 単一行アンカー
    expect(
      sourceToUrl({ kind: "interview", repo: "org/kb", path: "i.md", lines: "L5", ref: "main" }),
    ).toBe("https://github.com/org/kb/blob/main/i.md#L5");
  });

  it("ref が無ければ defaultBranch を使う", () => {
    expect(
      sourceToUrl({ kind: "meeting", repo: "org/m", path: "a.md" }, { defaultBranch: "main" }),
    ).toBe("https://github.com/org/m/blob/main/a.md");
  });

  it("ref も defaultBranch も無ければ KbProvenanceError", () => {
    expect(() => sourceToUrl({ kind: "meeting", repo: "org/m", path: "a.md" })).toThrow(
      KbProvenanceError,
    );
  });
});

describe("urlToSource", () => {
  it("discord / pr / issue を逆変換し round-trip する", () => {
    const cases: Source[] = [
      { kind: "discord", url: "https://discord.com/channels/1/2/3" },
      { kind: "pr", repo: "org/app", number: 12 },
      { kind: "issue", repo: "org/app", number: 7 },
    ];
    for (const s of cases) {
      expect(urlToSource(sourceToUrl(s))).toEqual(s);
    }
  });

  it("blob URL を meeting source(ref / lines 付き)に復元する", () => {
    const url = "https://github.com/org/minutes/blob/abc123/2026/a.md#L120-L141";
    expect(urlToSource(url)).toEqual({
      kind: "meeting",
      repo: "org/minutes",
      path: "2026/a.md",
      ref: "abc123",
      lines: "L120-L141",
    });
  });

  it("許可外ドメインを拒否する(§9.5)", () => {
    expect(() => urlToSource("https://evil.example/org/app/pull/1")).toThrow(KbProvenanceError);
  });

  it("構造不正(discord セグメント不足)を拒否する", () => {
    expect(() => urlToSource("https://discord.com/channels/1/2")).toThrow(KbProvenanceError);
  });
});

describe("parseLineRange", () => {
  it("範囲・単一行を解釈する", () => {
    expect(parseLineRange("L120-L141")).toEqual({ start: 120, end: 141 });
    expect(parseLineRange("L7")).toEqual({ start: 7, end: 7 });
  });

  it("逆転・不正形式を拒否する", () => {
    expect(() => parseLineRange("L141-L120")).toThrow(KbProvenanceError);
    expect(() => parseLineRange("120-141")).toThrow(KbProvenanceError);
  });
});
