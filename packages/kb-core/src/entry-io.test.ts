import { describe, expect, it } from "vitest";
import { parseEntry, safeParseEntry, serializeEntry } from "./entry-io.js";
import { KbParseError } from "./errors.js";

const KNOWLEDGE = `---
id: kb-2026-0142
title: タイトル
type: fact
domain: hardware
tags: ["a", "b"]
sources:
  - kind: discord
    url: "https://discord.com/channels/1/2/3"
confidence: high
status: active
created: "2026-06-10"
last_verified: "2026-06-10"
owner: yamada
---

## 事象
本文。
`;

describe("parseEntry", () => {
  it("正常系: frontmatter と本文を分離して parse する", () => {
    const { frontmatter, body } = parseEntry(KNOWLEDGE, "knowledge");
    expect(frontmatter.id).toBe("kb-2026-0142");
    expect(frontmatter.review_interval_days).toBe(180); // fact のデフォルト
    expect(body).toContain("## 事象");
  });

  it("日付は文字列として読む(YAML タイムスタンプに変換しない)", () => {
    const { frontmatter } = parseEntry(KNOWLEDGE, "knowledge");
    expect(typeof frontmatter.created).toBe("string");
    expect(frontmatter.created).toBe("2026-06-10");
  });

  it("frontmatter 欠落は MISSING_FRONTMATTER", () => {
    try {
      parseEntry("## 本文のみ\n", "knowledge");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(KbParseError);
      expect((error as KbParseError).code).toBe("MISSING_FRONTMATTER");
    }
  });

  it("YAML 構文エラーは INVALID_YAML", () => {
    const bad = "---\n\tid: kb-2026-0142\n  bad: : :\n---\n本文\n";
    try {
      parseEntry(bad, "knowledge");
      expect.unreachable();
    } catch (error) {
      expect((error as KbParseError).code).toBe("INVALID_YAML");
    }
  });

  it("スキーマ違反は SCHEMA_VIOLATION で、どのフィールドがなぜ不正かを持つ", () => {
    const noSources = KNOWLEDGE.replace(
      /sources:\n {2}- kind: discord\n {4}url: "https:\/\/discord.com\/channels\/1\/2\/3"\n/,
      "sources: []\n",
    );
    try {
      parseEntry(noSources, "knowledge");
      expect.unreachable();
    } catch (error) {
      const e = error as KbParseError;
      expect(e.code).toBe("SCHEMA_VIOLATION");
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues[0]!.path).toBe("sources");
      expect(e.issues[0]!.message.length).toBeGreaterThan(0);
    }
  });
});

describe("safeParseEntry", () => {
  it("成功時は ok:true でエントリを返す", () => {
    const result = safeParseEntry(KNOWLEDGE, "knowledge");
    expect(result.ok).toBe(true);
  });

  it("失敗時は ok:false で KbParseError を返す(throw しない)", () => {
    const result = safeParseEntry("本文のみ", "knowledge");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(KbParseError);
  });
});

describe("serializeEntry / round-trip", () => {
  it("parse → serialize → parse で frontmatter・本文が一致する", () => {
    const first = parseEntry(KNOWLEDGE, "knowledge");
    const text = serializeEntry(first);
    const second = parseEntry(text, "knowledge");
    expect(second.frontmatter).toEqual(first.frontmatter);
    expect(second.body).toEqual(first.body);
  });

  it("同一入力に対し決定的(出力文字列が安定)", () => {
    const parsed = parseEntry(KNOWLEDGE, "knowledge");
    expect(serializeEntry(parsed)).toBe(serializeEntry(parsed));
  });

  it("review_interval_days が null(decision)のときはキーを出力しない", () => {
    const decision = parseEntry(KNOWLEDGE.replace("type: fact", "type: decision"), "knowledge");
    const text = serializeEntry(decision);
    expect(text).not.toContain("review_interval_days");
    // round-trip でも null が復元される
    expect(parseEntry(text, "knowledge").frontmatter.review_interval_days).toBeNull();
  });

  it("KEY_ORDER 外の未知キーは無言で破棄せず throw する", () => {
    const parsed = parseEntry(KNOWLEDGE, "knowledge");
    const tampered = { ...parsed, frontmatter: { ...parsed.frontmatter, bogus: 1 } };
    try {
      serializeEntry(tampered as never);
      expect.unreachable();
    } catch (error) {
      const e = error as KbParseError;
      expect(e.code).toBe("SCHEMA_VIOLATION");
      expect(e.issues.some((i) => i.path === "bogus")).toBe(true);
    }
  });

  it("スキーマ違反の frontmatter はファイル化せず throw する", () => {
    const parsed = parseEntry(KNOWLEDGE, "knowledge");
    const broken = { ...parsed, frontmatter: { ...parsed.frontmatter, id: "kb-bad" } };
    expect(() => serializeEntry(broken)).toThrow(KbParseError);
  });

  it("id 接頭辞から docKind を推論して decision を直列化できる", () => {
    const dr = parseEntry(
      `---
id: dr-2026-0031
title: 決定
date: "2026-06-03"
status: accepted
deciders: ["yamada"]
sources:
  - kind: meeting
    repo: org/minutes
    path: a.md
tags: []
---

## 決定内容
`,
      "decision",
    );
    const text = serializeEntry(dr);
    expect(text).toContain('id: "dr-2026-0031"');
    expect(parseEntry(text, "decision").frontmatter).toEqual(dr.frontmatter);
  });
});
