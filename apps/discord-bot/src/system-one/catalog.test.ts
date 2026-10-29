import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRepoCatalog,
  classifyPath,
  createCatalogCache,
  parseMinutesHead,
  type RepoCatalog,
} from "./catalog.js";

const KB_ENTRY = `---
id: kb-2026-0142
title: 分注ロボット X は高湿度環境で Y 軸が脱調する
type: failure
domain: hardware
tags: ["dispenser-x", "humidity"]
sources:
  - kind: meeting
    repo: org/minutes
    path: 2026/06/2026-06-03-hw-weekly.md
people: ["yamada"]
confidence: high
status: active
created: "2026-06-10"
last_verified: "2026-06-10"
owner: yamada
---

## 事象
高湿度環境で Y 軸が脱調する。
`;

const DR_ENTRY = `---
id: dr-2026-0007
title: ファーム書き込みを SWD 直結にする
date: "2026-06-03"
status: accepted
deciders: ["yamada"]
sources:
  - kind: meeting
    repo: org/minutes
    path: 2026/06/2026-06-03-hw-weekly.md
tags: ["firmware"]
---

## 決定内容
SWD 直結に変更する。
`;

const MINUTES = `# 開発定例 2026-09-15

## エグゼクティブサマリー

- 分注ユニットの量産立ち上げ日程を 10 月第 2 週に確定した。
- その他

## 議題
`;

let root: string;
const write = (rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "s1-catalog-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const byPath = (c: RepoCatalog) => new Map(c.entries.map((e) => [e.path, e]));

describe("buildRepoCatalog(ADR-0041 D4)", () => {
  it("KB(knowledge / decisions)を kb-core で parse し、壊れたエントリは外す", async () => {
    write("knowledge/hardware/kb-2026-0142-x.md", KB_ENTRY);
    write("decisions/dr-2026-0007.md", DR_ENTRY);
    write("knowledge/hardware/broken.md", "---\nid: nope\n---\n本文");
    write("README.md", "# readme");
    const c = await buildRepoCatalog({ repo: "org/kb", absDir: root, sha: "s1" });
    const m = byPath(c);
    expect([...m.keys()].sort()).toEqual([
      "decisions/dr-2026-0007.md",
      "knowledge/hardware/kb-2026-0142-x.md",
    ]);
    const kb = m.get("knowledge/hardware/kb-2026-0142-x.md");
    expect(kb).toMatchObject({
      kind: "kb",
      repo: "org/kb",
      title: "分注ロボット X は高湿度環境で Y 軸が脱調する",
      domain: "hardware",
      tags: ["dispenser-x", "humidity"],
      status: "active",
      date: "2026-06-10",
    });
    expect(kb?.body).toContain("脱調する");
    expect(kb?.body).not.toContain("owner:"); // frontmatter は本文に含めない
    expect(m.get("decisions/dr-2026-0007.md")).toMatchObject({ date: "2026-06-03", kind: "kb" });
    expect(c.stats.kbParseErrors).toBe(1);
  });

  it("議事録の 2 つの配置(internal/external と mtg-<ISO>)と synthetic の日付つき配置", async () => {
    write("meetings/internal/2026/2026-09/2026_09_15_from_10-00_to_11-00_abcd/minutes.md", MINUTES);
    write("meetings/2026/2026-09/mtg-20260916T100000-ab12/minutes.md", "# 外部打合せ\n本文");
    write("2026/06/2026-06-03-hw-weekly.md", "# HW 定例 2026-06-03\n本文");
    const c = await buildRepoCatalog({ repo: "org/minutes", absDir: root, sha: "s1" });
    const m = byPath(c);
    const a = m.get(
      "meetings/internal/2026/2026-09/2026_09_15_from_10-00_to_11-00_abcd/minutes.md",
    );
    expect(a).toMatchObject({
      kind: "minutes",
      title: "開発定例 2026-09-15",
      date: "2026-09-15",
      summary: "分注ユニットの量産立ち上げ日程を 10 月第 2 週に確定した。",
    });
    expect(m.get("meetings/2026/2026-09/mtg-20260916T100000-ab12/minutes.md")).toMatchObject({
      title: "外部打合せ",
      date: "2026-09-16",
      summary: null,
    });
    expect(m.get("2026/06/2026-06-03-hw-weekly.md")).toMatchObject({ date: "2026-06-03" });
  });

  it("transcript.md は読まない", async () => {
    write("meetings/internal/2026/2026-09/2026_09_15_x/transcript.md", "# 書き起こし\n秘密");
    write("meetings/internal/2026/2026-09/2026_09_15_x/minutes.md", "# 議事録\n本文");
    write("2026/06/transcript.md", "# t");
    const c = await buildRepoCatalog({ repo: "org/minutes", absDir: root, sha: "s1" });
    expect(c.entries.map((e) => e.path)).toEqual([
      "meetings/internal/2026/2026-09/2026_09_15_x/minutes.md",
    ]);
    expect(c.entries.some((e) => e.body.includes("秘密"))).toBe(false);
  });

  it("symlink はファイル・ディレクトリとも辿らない(clone の外を読まない・ADR-0037)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "s1-outside-"));
    try {
      mkdirSync(join(outside, "x"), { recursive: true });
      writeFileSync(join(outside, "x", "minutes.md"), "# 外部 SECRET");
      writeFileSync(join(outside, "secret.md"), KB_ENTRY.replace("脱調する。", "SECRET"));
      mkdirSync(join(root, "meetings", "2026"), { recursive: true });
      symlinkSync(join(outside, "x"), join(root, "meetings", "2026", "linked"));
      mkdirSync(join(root, "knowledge", "hw"), { recursive: true });
      symlinkSync(join(outside, "secret.md"), join(root, "knowledge", "hw", "kb-2026-9999-s.md"));
      symlinkSync(outside, join(root, "decisions"));
      const c = await buildRepoCatalog({ repo: "org/r", absDir: root, sha: "s1" });
      expect(c.entries).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("1 ファイルの上限を超えるものは読まない", async () => {
    write("meetings/2026/a/minutes.md", `# 大きい\n${"あ".repeat(2000)}`);
    write("meetings/2026/b/minutes.md", "# 小さい\n本文");
    const c = await buildRepoCatalog({
      repo: "org/m",
      absDir: root,
      sha: "s1",
      limits: { maxFileBytes: 1000 },
    });
    expect(c.entries.map((e) => e.title)).toEqual(["小さい"]);
    expect(c.stats.skipped).toBe(1);
  });

  it("clone が無ければ空(throw しない)", async () => {
    const c = await buildRepoCatalog({ repo: "org/x", absDir: join(root, "nope"), sha: "s" });
    expect(c.entries).toEqual([]);
  });
});

describe("classifyPath / parseMinutesHead", () => {
  it("位置で種別を判定する", () => {
    expect(classifyPath("knowledge/hw/kb-1.md")).toBe("kb");
    expect(classifyPath("decisions/dr-1.md")).toBe("kb");
    expect(classifyPath("meetings/internal/2026/2026-06/x/minutes.md")).toBe("minutes");
    expect(classifyPath("meetings/internal/2026/2026-06/x/transcript.md")).toBe("other");
    expect(classifyPath("2026/06/2026-06-03-hw-weekly.md")).toBe("minutes");
    expect(classifyPath("minutes/2026/06/2026-06-03-hw-weekly.md")).toBe("minutes");
    expect(classifyPath("docs/calibration.md")).toBe("other");
    expect(classifyPath("src/2026/06/2026-06-03-x.md")).toBe("other");
  });

  it("summary は 120 字で切る", () => {
    const long = "あ".repeat(200);
    const h = parseMinutesHead(`# T\n\n## エグゼクティブサマリー\n\n${long}\n`);
    expect(h.title).toBe("T");
    expect([...(h.summary ?? "")].length).toBe(120);
    expect(h.summary?.endsWith("…")).toBe(true);
  });
});

describe("createCatalogCache(リポ + HEAD SHA のキー)", () => {
  it("HEAD が変わったリポだけ作り直し、範囲外のリポは捨てる・同時の要求は 1 回だけ作る", async () => {
    const build = vi.fn(async (i: { repo: string; sha: string }) => ({
      repo: i.repo,
      sha: i.sha,
      entries: [],
      stats: { files: 0, bytes: 0, kbParseErrors: 0, skipped: 0, truncated: false, ms: 0 },
    }));
    const cache = createCatalogCache({ build });
    const a = { repo: "org/a", absDir: "/a", sha: "1" };
    const b = { repo: "org/b", absDir: "/b", sha: "1" };
    await Promise.all([cache.refresh([a, b]), cache.refresh([a, b])]);
    expect(build).toHaveBeenCalledTimes(2);
    await cache.refresh([a, b]);
    expect(build).toHaveBeenCalledTimes(2);
    await cache.refresh([{ ...a, sha: "2" }, b]);
    expect(build).toHaveBeenCalledTimes(3);
    const c = await cache.refresh([b]);
    expect(c.repos.map((r) => r.repo)).toEqual(["org/b"]);
    await cache.refresh([{ ...a, sha: "2" }]);
    expect(build).toHaveBeenCalledTimes(4); // 捨てたので作り直す
  });
});
