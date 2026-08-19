import { type IdKind, parseEntry } from "@stratum/kb-core";
import { describe, expect, it } from "vitest";
import { type MaterializeInput, materializeOne } from "./materialize.js";

/** 決定的な連番スタブ(実装は kb-core newId の乱数採番・ADR-0026)。suffix は base36 6文字。 */
function stubMakeId(): (kind: IdKind) => string {
  let n = 0;
  return (kind) => `${kind}-2026-t${String(++n).padStart(5, "0")}`;
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
  it("sourceDate(源泉日・ADR-0026 D3)が created/last_verified/date と makeId の年に伝わる", async () => {
    const sourceDate = new Date("2026-06-11T00:00:00+09:00");
    const calls: (Date | undefined)[] = [];
    const makeId = (kind: string, now?: Date): string => {
      calls.push(now);
      return `${kind}-2026-src001`;
    };
    // learning: created / last_verified = 源泉日
    const learning = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "abc" },
        fallbackPeople: ["yamada"],
        candidate: {
          kind: "learning",
          title: "t",
          body: "b",
          entryType: "fact",
          domain: "hardware",
          people: [],
          tags: [],
          confidence: "high",
          slug: "s",
        },
        verdict: { classification: "new", reason: "新規" },
        sourceDate,
      },
      { makeId, now: NOW },
    );
    const lf = parseEntry(learning.files[0]?.content ?? "", "knowledge");
    expect(lf.frontmatter.created).toBe("2026-06-11");
    expect(lf.frontmatter.last_verified).toBe("2026-06-11");
    expect(calls[0]?.toISOString()).toBe(sourceDate.toISOString()); // makeId に源泉日が渡る(ID の年)

    // decision: date = 源泉日(会議で決めた日)
    const decision = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "abc" },
        fallbackPeople: ["yamada"],
        candidate: {
          kind: "decision",
          title: "t",
          decision: "d",
          deciders: ["yamada"],
          confidence: "high",
          slug: "s",
        },
        verdict: { classification: "new", reason: "新規" },
        sourceDate,
      },
      { makeId, now: NOW },
    );
    const df = parseEntry(decision.files[0]?.content ?? "", "decision");
    expect(df.frontmatter.date).toBe("2026-06-11");
  });

  it("learning → knowledge/<domain>/kb-2026-t00001-<slug>.md(meeting 出典・round-trip)", async () => {
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
    const r = await materializeOne(input, { makeId: stubMakeId(), now: NOW });
    expect(r.action).toBe("new");
    expect(r.id).toBe("kb-2026-t00001");
    expect(r.files).toHaveLength(1);
    const f = r.files[0];
    expect(f?.path).toBe("knowledge/hardware/kb-2026-t00001-humidity-threshold.md");
    const parsed = parseEntry(f?.content ?? "", "knowledge");
    expect(parsed.frontmatter.id).toBe("kb-2026-t00001");
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

  it("decision → decisions/2026/dr-2026-t00001-<slug>.md(却下理由を body に)", async () => {
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
      { makeId: stubMakeId(), now: NOW },
    );
    expect(r.action).toBe("new");
    expect(r.id).toBe("dr-2026-t00001");
    const f = r.files[0];
    expect(f?.path).toBe("decisions/2026/dr-2026-t00001-firmware-swd.md");
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
      { makeId: stubMakeId(), now: NOW },
    );
    expect(r.action).toBe("skip");
    expect(r.files).toHaveLength(0);
    expect(r.reasonCode).toBe("no_deciders"); // 呼び出し側が open question 化する(ADR-0027 D3)
  });
});

describe("materializeOne — 検証状態(ADR-0027 D4・kb-core v5)", () => {
  it("新規 learning は verification_status: unverified で作られる(機械生成)", async () => {
    const r = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
        fallbackPeople: [],
        candidate: {
          kind: "learning",
          title: "t",
          body: "b",
          entryType: "fact",
          domain: "hardware",
          people: ["yamada"],
          tags: [],
          confidence: "high",
          slug: "t",
        },
        verdict: { classification: "new", reason: "新規" },
      },
      { makeId: stubMakeId(), now: NOW },
    );
    expect(r.files[0]?.content).toContain('verification_status: "unverified"');
  });
});

describe("materializeOne — 人物帰属の厳格化(ADR-0027 D1)", () => {
  const decisionInput = (
    deciders: string[],
    over: Partial<MaterializeInput> = {},
  ): MaterializeInput => ({
    kbRoot: "/kb",
    source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
    fallbackPeople: ["yamada", "suzuki"],
    candidate: { kind: "decision", title: "x", decision: "y", deciders, confidence: "high" },
    verdict: { classification: "new", reason: "新規" },
    ...over,
  });

  it("deciders 空でも参加者全員を補完しない(extractor 経路は skip・ADR 検証2)", async () => {
    const r = await materializeOne(decisionInput([]), { makeId: stubMakeId(), now: NOW });
    expect(r.action).toBe("skip");
    expect(r.files).toHaveLength(0);
    expect(r.reason).toContain("決定者");
  });

  it("allowPeopleFallback(pr-miner 経路)は deciders 空を fallbackPeople で補完する", async () => {
    const r = await materializeOne(decisionInput([], { allowPeopleFallback: true }), {
      makeId: stubMakeId(),
      now: NOW,
    });
    expect(r.action).toBe("new");
    const parsed = parseEntry(r.files[0]?.content ?? "", "decision");
    expect(parsed.frontmatter.deciders).toEqual(["yamada", "suzuki"]);
  });

  it("「会議参加者」等の集合名 decider は機械拒否する(ADR 検証3)", async () => {
    const r = await materializeOne(decisionInput(["会議参加者"]), {
      makeId: stubMakeId(),
      now: NOW,
    });
    expect(r.action).toBe("skip");
  });

  it("集合名・記号/数字のみを除いても残る decider だけで materialize する", async () => {
    const r = await materializeOne(decisionInput(["全員", "02", "/", "yamada"]), {
      makeId: stubMakeId(),
      now: NOW,
    });
    expect(r.action).toBe("new");
    const parsed = parseEntry(r.files[0]?.content ?? "", "decision");
    expect(parsed.frontmatter.deciders).toEqual(["yamada"]);
  });

  it("learning の people/owner にも集合名ガードが効く(ADR-0031 D4)", async () => {
    const r = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
        fallbackPeople: [],
        candidate: {
          kind: "learning",
          title: "t",
          body: "b",
          entryType: "fact",
          domain: "hardware",
          people: ["会議参加者", "yamada"],
          tags: [],
          confidence: "high",
          slug: "t",
        },
        verdict: { classification: "new", reason: "新規" },
      },
      { makeId: stubMakeId(), now: NOW },
    );
    const parsed = parseEntry(r.files[0]?.content ?? "", "knowledge");
    expect(parsed.frontmatter.owner).toBe("yamada"); // 先頭の**有効な**人物(集合名を owner にしない)
    if (parsed.frontmatter.id.startsWith("kb-")) {
      expect((parsed.frontmatter as { people?: string[] }).people).toEqual(["yamada"]);
    }
  });

  it("people が集合名のみの learning は owner: unassigned(ADR-0031 D4)", async () => {
    const r = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
        fallbackPeople: [],
        candidate: {
          kind: "learning",
          title: "t",
          body: "b",
          entryType: "fact",
          domain: "hardware",
          people: ["会議参加者"],
          tags: [],
          confidence: "high",
          slug: "t",
        },
        verdict: { classification: "new", reason: "新規" },
      },
      { makeId: stubMakeId(), now: NOW },
    );
    const parsed = parseEntry(r.files[0]?.content ?? "", "knowledge");
    expect(parsed.frontmatter.owner).toBe("unassigned");
  });

  it("people 空の learning は参加者を owner にせず unassigned(ADR 検証4)", async () => {
    const learningInput = (allowPeopleFallback: boolean): MaterializeInput => ({
      kbRoot: "/kb",
      source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
      fallbackPeople: ["yamada"],
      allowPeopleFallback,
      candidate: {
        kind: "learning",
        title: "t",
        body: "b",
        entryType: "fact",
        domain: "hardware",
        people: [],
        tags: [],
        confidence: "high",
        slug: "s",
      },
      verdict: { classification: "new", reason: "新規" },
    });
    const extractor = await materializeOne(learningInput(false), {
      makeId: stubMakeId(),
      now: NOW,
    });
    expect(parseEntry(extractor.files[0]?.content ?? "", "knowledge").frontmatter.owner).toBe(
      "unassigned",
    );
    // pr-miner 経路(author = 当事者)だけはフォールバックを維持する。
    const miner = await materializeOne(learningInput(true), { makeId: stubMakeId(), now: NOW });
    expect(parseEntry(miner.files[0]?.content ?? "", "knowledge").frontmatter.owner).toBe("yamada");
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
      makeId: stubMakeId(),
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
      makeId: stubMakeId(),
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
      makeId: stubMakeId(),
      now: NOW,
      readFile: async () => withPr,
    });
    expect(parseEntry(rSame.files[0]?.content ?? "", "knowledge").frontmatter.sources).toHaveLength(
      1,
    );
    const rDiff = await materializeOne(diff, {
      makeId: stubMakeId(),
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
      { makeId: stubMakeId(), now: NOW, readFile: async () => existing0142 },
    );
    expect(r.action).toBe("supersede");
    expect(r.id).toBe("kb-2026-t00001");
    expect(r.files).toHaveLength(2);
    const oldF = r.files.find((f) => f.path.includes("kb-2026-0142"));
    const newF = r.files.find((f) => f.path.includes("kb-2026-t00001"));
    expect(parseEntry(oldF?.content ?? "", "knowledge").frontmatter.status).toBe("superseded");
    const newParsed = parseEntry(newF?.content ?? "", "knowledge");
    expect(newParsed.frontmatter.supersedes).toBe("kb-2026-0142");
    expect(newParsed.frontmatter.status).toBe("active");
  });

  it("decision の矛盾更新は新 DR に supersedes(dr-ID)を付ける(ADR-0027 D4・v5)", async () => {
    const existingDr = `---
id: "dr-2026-0031"
title: "旧決定"
date: "2026-06-03"
status: "accepted"
deciders:
  - "yamada"
sources:
  - kind: "meeting"
    repo: "org/minutes"
    path: "old.md"
tags: []
---
本文
`;
    const r = await materializeOne(
      {
        kbRoot: "/kb",
        source: { kind: "meeting", repo: "org/minutes", path: "m.md", ref: "sha" },
        fallbackPeople: [],
        candidate: {
          kind: "decision",
          title: "新決定",
          decision: "方式を B に変更する。",
          deciders: ["yamada"],
          confidence: "high",
          slug: "new-decision",
        },
        verdict: {
          classification: "contradiction",
          targetPath: "decisions/2026/dr-2026-0031-old.md",
          targetId: "dr-2026-0031",
          reason: "決定の置き換え",
        },
      },
      { makeId: stubMakeId(), now: NOW, readFile: async () => existingDr },
    );
    expect(r.action).toBe("supersede");
    const newF = r.files.find((f) => f.path.includes("dr-2026-t00001"));
    const newParsed = parseEntry(newF?.content ?? "", "decision");
    expect(newParsed.frontmatter.supersedes).toBe("dr-2026-0031");
    const oldF = r.files.find((f) => f.path.includes("dr-2026-0031"));
    expect(parseEntry(oldF?.content ?? "", "decision").frontmatter.status).toBe("superseded");
  });
});
