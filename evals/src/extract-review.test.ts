import type { ExtractionResult } from "@stratum/extractor/candidate";
import { describe, expect, it } from "vitest";
import {
  buildReviewSheet,
  parseReviewSheet,
  type ReviewSheet,
  scoreReview,
  selectLatestMinutes,
  serializeReviewSheet,
} from "./extract-review.js";

const extraction: ExtractionResult = {
  decisions: [
    {
      kind: "decision",
      title: "SWD 直結に変更",
      decision: "CAN 経由から SWD 直結に変更する",
      deciders: ["yamada"],
      lines: "L14-L16",
      confidence: "high",
    },
  ],
  learnings: [
    {
      kind: "learning",
      title: "高湿度で Y 軸脱調",
      body: "45%RH 超で脱調。原因はベルトの伸び",
      entryType: "fact",
      domain: "hardware",
      people: ["yamada"],
      tags: [],
      confidence: "high",
    },
  ],
  openQuestions: [{ kind: "open_question", title: "恒久しきい値", body: "45%RH の恒久値は未定" }],
};

describe("buildReviewSheet", () => {
  it("3種の候補を verdict:null の項目に変換する(learning は domain を持つ)", () => {
    const sheet = buildReviewSheet("2026/06/a.md", extraction);
    expect(sheet.file).toBe("2026/06/a.md");
    expect(sheet.items).toHaveLength(3);
    expect(sheet.items.map((i) => i.kind)).toEqual(["decision", "learning", "open_question"]);
    expect(sheet.items.every((i) => i.verdict === null)).toBe(true);
    expect(sheet.items[1]?.domain).toBe("hardware");
    expect(sheet.items[0]?.lines).toBe("L14-L16");
  });
});

describe("serialize / parse round-trip", () => {
  it("未記入(null)のまま round-trip できる", () => {
    const sheet = buildReviewSheet("a.md", extraction, "2026-07-05T00:00:00Z");
    const parsed = parseReviewSheet(serializeReviewSheet(sheet));
    expect(parsed).toEqual(sheet);
  });
  it("人間が記入した ok/ng/note をパースできる", () => {
    const sheet = buildReviewSheet("a.md", extraction);
    const item0 = sheet.items[0];
    const item1 = sheet.items[1];
    if (item0 === undefined || item1 === undefined) throw new Error("unreachable");
    item0.verdict = "ok";
    item1.verdict = "ng";
    item1.note = "行範囲が本文と不一致";
    const parsed = parseReviewSheet(serializeReviewSheet(sheet));
    expect(parsed.items[0]?.verdict).toBe("ok");
    expect(parsed.items[1]?.verdict).toBe("ng");
    expect(parsed.items[1]?.note).toContain("不一致");
  });
  it("不正な verdict(maybe 等)は拒否する", () => {
    const raw = serializeReviewSheet(buildReviewSheet("a.md", extraction)).replace(
      /verdict: null/,
      "verdict: maybe",
    );
    expect(() => parseReviewSheet(raw)).toThrow();
  });
});

describe("scoreReview", () => {
  const sheet = (marks: ("ok" | "ng" | null)[]): ReviewSheet => ({
    file: "x.md",
    items: marks.map((verdict, i) => ({
      kind: i % 2 === 0 ? "decision" : "learning",
      title: `t${i}`,
      summary: "s",
      verdict,
    })),
  });

  it("precision = ok/(ok+ng)、perKind も集計する", () => {
    const score = scoreReview([sheet(["ok", "ok", "ng", "ok"])]);
    expect(score.total).toBe(4);
    expect(score.ok).toBe(3);
    expect(score.ng).toBe(1);
    expect(score.precision).toBe(0.75);
    expect(score.perKind.decision.total).toBe(2);
    expect(score.perKind.learning.total).toBe(2);
    expect(score.pass).toBe(false);
  });
  it("境界 0.8 ちょうどは合格(8 ok / 2 ng)", () => {
    const score = scoreReview([
      sheet(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ng", "ng"]),
    ]);
    expect(score.precision).toBe(0.8);
    expect(score.pass).toBe(true);
  });
  it("未記入があると pass=false(unmarked を数える)", () => {
    const score = scoreReview([sheet(["ok", null])]);
    expect(score.unmarked).toBe(1);
    expect(score.pass).toBe(false);
  });
  it("判定済み 0 件は precision null で不合格", () => {
    const score = scoreReview([sheet([null, null])]);
    expect(score.precision).toBeNull();
    expect(score.pass).toBe(false);
  });
});

describe("selectLatestMinutes", () => {
  it("transcript.md を除外しパス降順で limit 件を選ぶ", () => {
    const paths = [
      "meetings/2026-06/a/minutes.md",
      "meetings/2026-06/a/transcript.md",
      "meetings/2026-05/b/minutes.md",
      "meetings/2026-07/c/minutes.md",
      "meetings/2026-07/c/notes.txt",
    ];
    expect(selectLatestMinutes(paths, 2)).toEqual([
      "meetings/2026-07/c/minutes.md",
      "meetings/2026-06/a/minutes.md",
    ]);
  });
});
