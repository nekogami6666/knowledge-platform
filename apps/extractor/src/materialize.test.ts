import { type IdCounterFile, type IdCounterStore, parseEntry } from "@stratum/kb-core";
import { describe, expect, it } from "vitest";
import { type MaterializeInput, materializeOne } from "./materialize.js";

const SEED: IdCounterFile = { kb: { "2026": 143 }, dr: { "2026": 31 }, q: { "2026": 88 } };

function memStore(seed: IdCounterFile): IdCounterStore {
  let counters = structuredClone(seed);
  let version = "v0";
  let n = 0;
  return {
    load: async () => ({ counters: structuredClone(counters), version }),
    save: async (c, expected) => {
      if (expected !== version) throw new Error("conflict");
      counters = structuredClone(c);
      n += 1;
      version = `v${n}`;
    },
  };
}

// 既存 KB エントリ(reconcile の target)。readFile fake が返す。
const existing0142 = `---
id: kb-2026-0142
title: 分注ロボット X は高湿度環境で Y 軸が脱調する
type: failure
domain: hardware
tags: ["dispenser-x"]
sources:
  - kind: meeting
    repo: org/minutes
    path: 2026/06/2026-06-03-hw-weekly.md
    lines: "L120-L141"
people: ["yamada"]
confidence: high
status: active
created: "2026-06-10"
last_verified: "2026-06-10"
review_interval_days: 365
owner: yamada
---

## 事象
高湿度で Y 軸脱調。
`;

const NOW = () => new Date("2026-07-01T00:00:00Z");

describe("materializeOne — new", () => {
  it("learning → knowledge/<domain>/kb-2026-0144-<slug>.md(meeting 出典・round-trip)", async () => {
    const input: MaterializeInput = {
      kbRoot: "/kb",
      source: {
        kind: "meeting",
        repo: "org/minutes",
        path: "2026/06/2026-06-10-hw-weekly.md",
        ref: "abc123",
      },
      fallbackPeople: ["yamada"],
      candidate: {
        kind: "learning",
        title: "湿度しきい値の更新",
        body: "40%RH 以下に更新",
        entryType: "fact",
        domain: "hardware",
        people: ["suzuki"],
        tags: ["humidity"],
        confidence: "high",
        slug: "humidity-threshold",
      },
      verdict: { classification: "new", reason: "新規" },
    };
    const r = await materializeOne(input, { idStore: memStore(SEED), now: NOW });
    expect(r.action).toBe("new");
    expect(r.id).toBe("kb-2026-0144");
    expect(r.files).toHaveLength(1);
    const f = r.files[0];
    expect(f?.path).toBe("knowledge/hardware/kb-2026-0144-humidity-threshold.md");
    const parsed = parseEntry(f?.content ?? "", "knowledge");
    expect(parsed.frontmatter.id).toBe("kb-2026-0144");
    expect(parsed.frontmatter.owner).toBe("suzuki");
    expect(parsed.frontmatter.sources).toHaveLength(1);
    const src = parsed.frontmatter.sources[0];
    expect(src).toMatchObject({
      kind: "meeting",
      repo: "org/minutes",
      path: "2026/06/2026-06-10-hw-weekly.md",
      ref: "abc123",
    });
  });

  it("decision → decisions/2026/dr-2026-0032-<slug>.md(却下理由を body に)", async () => {
    const r = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
        fallbackPeople: [],
        candidate: {
          kind: "decision",
          title: "SWD に変更",
          decision: "CAN 経由から SWD 直結に変更",
          rejectedAlternatives: "CAN は書き込みが遅い",
          deciders: ["yamada", "sato"],
          confidence: "high",
          slug: "firmware-swd",
        },
        verdict: { classification: "new", reason: "新規" },
      },
      { idStore: memStore(SEED), now: NOW },
    );
    expect(r.action).toBe("new");
    expect(r.id).toBe("dr-2026-0032");
    const f = r.files[0];
    expect(f?.path).toBe("decisions/2026/dr-2026-0032-firmware-swd.md");
    const parsed = parseEntry(f?.content ?? "", "decision");
    expect(parsed.frontmatter.deciders).toEqual(["yamada", "sato"]);
    expect(parsed.frontmatter.status).toBe("accepted");
    expect(f?.content).toContain("却下理由");
  });

  it("決定者が特定できなければ skip(D5)", async () => {
    const r = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
        fallbackPeople: [],
        candidate: { kind: "decision", title: "x", decision: "y", deciders: [], confidence: "low" },
        verdict: { classification: "new", reason: "新規" },
      },
      { idStore: memStore(SEED), now: NOW },
    );
    expect(r.action).toBe("skip");
    expect(r.files).toHaveLength(0);
  });
});

describe("materializeOne — duplicate", () => {
  const dupInput = (minutesPath: string): MaterializeInput => ({
    kbRoot: "/kb",
    source: { kind: "meeting", repo: "org/minutes", path: minutesPath, ref: "sha2" },
    fallbackPeople: [],
    candidate: {
      kind: "learning",
      title: "湿度",
      body: "高湿度で脱調",
      entryType: "failure",
      domain: "hardware",
      people: [],
      tags: [],
      confidence: "high",
    },
    verdict: {
      classification: "duplicate",
      targetPath: "knowledge/hardware/kb-2026-0142-dispenser-x-humidity.md",
      targetId: "kb-2026-0142",
      reason: "既出",
    },
  });

  it("新しい出典を既存に追記(採番なし)", async () => {
    const r = await materializeOne(dupInput("2026/06/2026-06-10-hw-weekly.md"), {
      idStore: memStore(SEED),
      now: NOW,
      readFile: async () => existing0142,
    });
    expect(r.action).toBe("append");
    expect(r.id).toBe("kb-2026-0142");
    const f = r.files[0];
    expect(f?.path).toBe("knowledge/hardware/kb-2026-0142-dispenser-x-humidity.md");
    const parsed = parseEntry(f?.content ?? "", "knowledge");
    expect(parsed.frontmatter.sources).toHaveLength(2);
    expect(f?.content).toContain("2026-06-10-hw-weekly.md");
  });

  it("同一出典は重複追記しない", async () => {
    const r = await materializeOne(dupInput("2026/06/2026-06-03-hw-weekly.md"), {
      idStore: memStore(SEED),
      now: NOW,
      readFile: async () => existing0142,
    });
    const parsed = parseEntry(r.files[0]?.content ?? "", "knowledge");
    expect(parsed.frontmatter.sources).toHaveLength(1);
  });

  it("pr 出典も kind 別の同一性で重複判定する(PR-P2 汎用化)", async () => {
    // 既存が pr 出典を1件持つエントリ。同一 repo+number は追記せず、異なる number は追記する。
    const withPr = existing0142.replace(
      'sources:\n  - kind: meeting\n    repo: org/minutes\n    path: 2026/06/2026-06-03-hw-weekly.md\n    lines: "L120-L141"',
      "sources:\n  - kind: pr\n    repo: org/dev-repo\n    number: 42",
    );
    const base = dupInput("ignored.md");
    const same: MaterializeInput = {
      ...base,
      source: { kind: "pr", repo: "org/dev-repo", number: 42 },
    };
    const diff: MaterializeInput = {
      ...base,
      source: { kind: "pr", repo: "org/dev-repo", number: 43 },
    };
    const rSame = await materializeOne(same, {
      idStore: memStore(SEED),
      now: NOW,
      readFile: async () => withPr,
    });
    expect(parseEntry(rSame.files[0]?.content ?? "", "knowledge").frontmatter.sources).toHaveLength(
      1,
    );
    const rDiff = await materializeOne(diff, {
      idStore: memStore(SEED),
      now: NOW,
      readFile: async () => withPr,
    });
    expect(parseEntry(rDiff.files[0]?.content ?? "", "knowledge").frontmatter.sources).toHaveLength(
      2,
    );
  });
});

describe("materializeOne — contradiction", () => {
  it("旧を superseded・新に supersedes を付与", async () => {
    const r = await materializeOne(
      {
        kbRoot: "/kb",
        source: {
          kind: "meeting",
          repo: "org/minutes",
          path: "2026/06/2026-06-10-hw-weekly.md",
          ref: "sha3",
        },
        fallbackPeople: ["yamada"],
        candidate: {
          kind: "learning",
          title: "湿度しきい値 40%RH",
          body: "推奨しきい値を 40%RH 以下に更新",
          entryType: "failure",
          domain: "hardware",
          people: ["yamada"],
          tags: [],
          confidence: "high",
          slug: "humidity-40",
        },
        verdict: {
          classification: "contradiction",
          targetPath: "knowledge/hardware/kb-2026-0142-dispenser-x-humidity.md",
          targetId: "kb-2026-0142",
          reason: "しきい値が 45→40 に更新",
        },
      },
      { idStore: memStore(SEED), now: NOW, readFile: async () => existing0142 },
    );
    expect(r.action).toBe("supersede");
    expect(r.id).toBe("kb-2026-0144");
    expect(r.files).toHaveLength(2);
    const oldF = r.files.find((f) => f.path.includes("kb-2026-0142"));
    const newF = r.files.find((f) => f.path.includes("kb-2026-0144"));
    expect(parseEntry(oldF?.content ?? "", "knowledge").frontmatter.status).toBe("superseded");
    const newParsed = parseEntry(newF?.content ?? "", "knowledge");
    expect(newParsed.frontmatter.supersedes).toBe("kb-2026-0142");
    expect(newParsed.frontmatter.status).toBe("active");
  });
});
