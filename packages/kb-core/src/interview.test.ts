import { describe, expect, it } from "vitest";
import {
  buildInterviewSessionDoc,
  interviewKitPath,
  interviewSessionPath,
  interviewSlug,
} from "./interview.js";

describe("interviewSlug", () => {
  it("ASCII kebab 化する(interview-kit 旧 slugify と同値)", () => {
    expect(interviewSlug("Robot Control")).toBe("robot-control");
    expect(interviewSlug("robot_control v2")).toBe("robot-control-v2");
  });

  it("日本語は空になるため x にフォールバックする", () => {
    expect(interviewSlug("恒温槽の校正")).toBe("x");
  });
});

describe("interviewKitPath", () => {
  it("interviews/kits/<person>-<topic>.md(旧 interview-kit kitPath と同一規約)", () => {
    expect(interviewKitPath("yamada", "robot-control")).toBe(
      "interviews/kits/yamada-robot-control.md",
    );
  });
});

describe("interviewSessionPath", () => {
  it("interviews/sessions/<YYYY>/<date>-<person>-<topic>-<sid6>.md を生成する", () => {
    expect(interviewSessionPath("2026-08-14", "yamada", "robot-control", "a3f8x7bq")).toBe(
      "interviews/sessions/2026/2026-08-14-yamada-robot-control-a3f8x7.md",
    );
  });

  it("日本語 person/topic(slug x)でも sessionId サフィックスで一意になる(ADR-0028 D4)", () => {
    const a = interviewSessionPath("2026-08-14", "山田", "校正", "aaaaaa");
    const b = interviewSessionPath("2026-08-14", "鈴木", "配線", "bbbbbb");
    expect(a).toBe("interviews/sessions/2026/2026-08-14-x-x-aaaaaa.md");
    expect(a).not.toBe(b);
  });

  it("パスに源泉日(YYYY-MM-DD)が含まれる(extractor source-date 規約)", () => {
    const p = interviewSessionPath("2026-08-14", "yamada", "t", "s1");
    expect(/(\d{4})[_-](\d{2})[_-](\d{2})/.exec(p)?.[0]).toBe("2026-08-14");
  });
});

describe("buildInterviewSessionDoc", () => {
  const doc = buildInterviewSessionDoc({
    person: "yamada",
    topic: "恒温槽の校正",
    kitPath: "interviews/kits/yamada-x.md",
    participants: ["yamada", "Shoma Nagata"],
    dateJst: "2026-08-14",
    sttModel: "whisper-1",
    channelUrl: "https://discord.com/channels/1/2",
    chunkCount: 3,
    transcript: "こんにちは。\n\n校正の話。",
  });

  it("冒頭に「参加者:」1 行(カンマ区切り)を置く(extractor parseParticipants 契約)", () => {
    const line = doc.split("\n").find((l) => l.startsWith("参加者:"));
    expect(line).toBe("参加者: yamada, Shoma Nagata");
    // extractor participants.ts と同じ正規表現で往復できること
    const m = /(?:参加者|participants?)\s*[:：]\s*(.+)/i.exec(doc);
    expect(m?.[1]?.split(/[,、/]/).map((s) => s.trim())).toEqual(["yamada", "Shoma Nagata"]);
  });

  it("キット参照・チャンク数・文字起こし全文を含む", () => {
    expect(doc).toContain("`interviews/kits/yamada-x.md`");
    expect(doc).toContain("チャンク 3 本・自動分割");
    expect(doc).toContain("## 文字起こし");
    expect(doc).toContain("校正の話。");
  });

  it("kitPath: null ではキット行を出さない", () => {
    const noKit = buildInterviewSessionDoc({
      person: "a",
      topic: "b",
      kitPath: null,
      participants: ["a"],
      dateJst: "2026-08-14",
      sttModel: "whisper-1",
      channelUrl: "https://x",
      chunkCount: 1,
      transcript: "t",
    });
    expect(noKit).not.toContain("質問キット");
  });
});
