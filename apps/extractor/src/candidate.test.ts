import { describe, expect, it } from "vitest";
import {
  decisionCandidateSchema,
  extractionResultSchema,
  learningCandidateSchema,
  openQuestionCandidateSchema,
} from "./candidate.js";

describe("decisionCandidateSchema", () => {
  it("決定候補を受理(任意項目は省略可)", () => {
    const r = decisionCandidateSchema.parse({
      kind: "decision",
      title: "SWD に変更",
      decision: "CAN から SWD 直結に変更",
      deciders: [],
      confidence: "high",
    });
    expect(r.deciders).toEqual([]);
    expect(r.rationale).toBeUndefined();
  });
  it("不明なキーは strict で拒否", () => {
    expect(() =>
      decisionCandidateSchema.parse({
        kind: "decision",
        title: "x",
        decision: "y",
        deciders: [],
        confidence: "low",
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("learningCandidateSchema", () => {
  it("学び候補を受理", () => {
    const r = learningCandidateSchema.parse({
      kind: "learning",
      title: "高湿度で Y 軸脱調",
      body: "45%RH 超で脱調",
      entryType: "failure",
      domain: "hardware",
      people: [],
      tags: [],
      confidence: "high",
    });
    expect(r.people).toEqual([]);
    expect(r.tags).toEqual([]);
  });
  it("domain は英小文字のみ(大文字を拒否)", () => {
    expect(() =>
      learningCandidateSchema.parse({
        kind: "learning",
        title: "x",
        body: "y",
        entryType: "fact",
        domain: "Hardware",
        people: [],
        tags: [],
        confidence: "low",
      }),
    ).toThrow();
  });
  it("entryType に decision は不可(決定は decisionCandidate へ)", () => {
    expect(() =>
      learningCandidateSchema.parse({
        kind: "learning",
        title: "x",
        body: "y",
        entryType: "decision",
        domain: "hw",
        people: [],
        tags: [],
        confidence: "low",
      }),
    ).toThrow();
  });
  it("lines は L12 / L12-L18 形式のみ", () => {
    expect(
      learningCandidateSchema.parse({
        kind: "learning",
        title: "x",
        body: "y",
        entryType: "fact",
        domain: "hw",
        people: [],
        tags: [],
        confidence: "low",
        lines: "L12-L18",
      }).lines,
    ).toBe("L12-L18");
    expect(() =>
      learningCandidateSchema.parse({
        kind: "learning",
        title: "x",
        body: "y",
        entryType: "fact",
        domain: "hw",
        people: [],
        tags: [],
        confidence: "low",
        lines: "12-18",
      }),
    ).toThrow();
  });
});

describe("openQuestionCandidateSchema", () => {
  it("最小の問い候補を受理", () => {
    expect(
      openQuestionCandidateSchema.parse({
        kind: "open_question",
        title: "温度補正?",
        body: "未確認",
      }).kind,
    ).toBe("open_question");
  });
});

describe("extractionResultSchema", () => {
  it("全カテゴリ空配列(雑談・連絡のみの議事録)を受理", () => {
    expect(
      extractionResultSchema.parse({ decisions: [], learnings: [], openQuestions: [] }),
    ).toEqual({
      decisions: [],
      learnings: [],
      openQuestions: [],
    });
  });
  it("3 カテゴリは必須(欠落は拒否)", () => {
    expect(() => extractionResultSchema.parse({ decisions: [], learnings: [] })).toThrow();
  });
  it("混在を受理する", () => {
    const r = extractionResultSchema.parse({
      decisions: [
        { kind: "decision", title: "a", decision: "b", deciders: [], confidence: "high" },
      ],
      learnings: [
        {
          kind: "learning",
          title: "c",
          body: "d",
          entryType: "fact",
          domain: "hw",
          people: [],
          tags: [],
          confidence: "low",
        },
      ],
      openQuestions: [],
    });
    expect(r.decisions).toHaveLength(1);
    expect(r.learnings).toHaveLength(1);
    expect(r.openQuestions).toEqual([]);
  });
});
