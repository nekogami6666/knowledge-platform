import { describe, expect, it } from "vitest";
import { buildVoiceMemoDoc, voiceMemoPath } from "./voice-memo.js";

describe("voiceMemoPath", () => {
  it("interviews/voice-memos/<YYYY>/<date>-<messageId>.md を返す(決定的 = 冪等)", () => {
    expect(voiceMemoPath("2026-07-08", "123456789")).toBe(
      "interviews/voice-memos/2026/2026-07-08-123456789.md",
    );
  });
});

describe("buildVoiceMemoDoc", () => {
  it("来歴ヘッダ + 無加工の文字起こし全文(P1)", () => {
    const doc = buildVoiceMemoDoc({
      transcript: "分注ユニットの X 軸は月イチで給脂が必要。",
      messageUrl: "https://discord.com/channels/G/C/M",
      author: "yamada",
      dateJst: "2026-07-08",
      sttModel: "gpt-4o-transcribe",
    });
    expect(doc).toContain("# Voice memo 2026-07-08(yamada)");
    expect(doc).toContain("- 出典: https://discord.com/channels/G/C/M");
    expect(doc).toContain("- 文字起こし: gpt-4o-transcribe");
    expect(doc).toContain("## 文字起こし\n\n分注ユニットの X 軸は月イチで給脂が必要。");
  });
});
