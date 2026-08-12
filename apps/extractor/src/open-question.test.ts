import { parseEntry } from "@stratum/kb-core";
import { describe, expect, it } from "vitest";
import { EXTRACTOR_ASKED_BY, materializeOpenQuestion } from "./open-question.js";

const candidate = {
  kind: "open_question" as const,
  title: "分注ロボットの耐湿仕様は?",
  body: "会議では 40%RH 以下と 60%RH 以下の両説が出て確定しなかった。",
  lines: "L10-L12",
};

const source = {
  kind: "meeting" as const,
  repo: "org/minutes",
  path: "minutes/2026/06/2026-06-03-hw-weekly.md",
  ref: "abcdef1234567890",
  lines: "L10-L12",
};

describe("materializeOpenQuestion(ADR-0027 D3・検証テスト8)", () => {
  it("questionLogSchema 準拠の frontmatter で questions/open/<id>-<slug>.md を作る(round-trip)", () => {
    const file = materializeOpenQuestion({
      id: "q-2026-abc123",
      candidate,
      source,
      askedAt: new Date("2026-06-03T00:00:00+09:00"),
    });
    expect(file.path).toBe("questions/open/q-2026-abc123-entry.md"); // 日本語 title → slug は "entry" フォールバック
    // parseEntry(kb-core)で round-trip できる = validateRepo も通る形。
    const back = parseEntry(file.content, "question", file.path);
    expect(back.frontmatter).toEqual({
      id: "q-2026-abc123",
      asked_by: EXTRACTOR_ASKED_BY,
      asked_at: "2026-06-03T00:00:00+09:00",
      channel: "org/minutes",
      question: "分注ロボットの耐湿仕様は?",
      bot_answer_quality: "unanswered",
      status: "open",
    });
  });

  it("本文に質問の背景と元議事録の repo/path/ref/lines を記録する(QuestionLog に sources は無い)", () => {
    const file = materializeOpenQuestion({
      id: "q-2026-abc123",
      candidate,
      source,
      askedAt: new Date("2026-06-03T00:00:00+09:00"),
    });
    const back = parseEntry(file.content, "question", file.path);
    expect(back.body).toContain("両説が出て確定しなかった");
    expect(back.body).toContain("- repo: org/minutes");
    expect(back.body).toContain("- path: minutes/2026/06/2026-06-03-hw-weekly.md");
    expect(back.body).toContain("- ref: abcdef1234567890");
    expect(back.body).toContain("- lines: L10-L12");
  });

  it("ref / lines が無い出典でも組める(行は出力しない)", () => {
    const file = materializeOpenQuestion({
      id: "q-2026-abc123",
      candidate: { kind: "open_question", title: "humidity spec?", body: "b" },
      source: { kind: "interview", repo: "org/knowledge-base", path: "interviews/x.md" },
      askedAt: new Date("2026-06-03T00:00:00+09:00"),
    });
    expect(file.path).toBe("questions/open/q-2026-abc123-humidity-spec.md");
    const back = parseEntry(file.content, "question", file.path);
    expect(back.body).not.toContain("- ref:");
    expect(back.body).not.toContain("- lines:");
  });

  it("asked_at は源泉日を JST(+09:00)の ISO 8601 で写す(既存の isoJst 流儀)", () => {
    const file = materializeOpenQuestion({
      id: "q-2025-abc123",
      candidate,
      source,
      askedAt: new Date("2025-12-31T23:00:00+09:00"),
    });
    const back = parseEntry(file.content, "question", file.path);
    expect(back.frontmatter.asked_at).toBe("2025-12-31T23:00:00+09:00");
  });
});
