import { describe, expect, it } from "vitest";
import { canOfferShare, citesDiscord, formatRecordedAt } from "./ask-keep-share.js";
import { createMemoryStore, type QueryRecord } from "./db.js";

describe("citesDiscord(ADR-0040 D3)", () => {
  it("discord 引用を 1 つでも含めば true、github だけなら false", () => {
    expect(citesDiscord(JSON.stringify([{ kind: "github_pr", repo: "o/r", number: 1 }]))).toBe(
      false,
    );
    expect(
      citesDiscord(
        JSON.stringify([
          { kind: "github_pr", repo: "o/r", number: 1 },
          { kind: "discord", url: "https://discord.com/channels/1/2/3" },
        ]),
      ),
    ).toBe(true);
  });

  it("null・壊れた JSON・配列でない・要素が object でないものは true(共有させない側)", () => {
    for (const s of [null, "{broken", "{}", "[1]", "[null]"]) {
      expect(citesDiscord(s)).toBe(true);
    }
  });
});

describe("canOfferShare / formatRecordedAt", () => {
  const q = (over: Partial<QueryRecord> = {}): QueryRecord => ({
    id: "q1",
    correlationId: "c",
    discordUserId: "u1",
    discordChannelId: "ch",
    threadId: null,
    question: "?",
    answer: "A",
    sourcesJson: "[]",
    answerStatus: "answered",
    feedback: null,
    inputTokens: null,
    outputTokens: null,
    elapsedMs: null,
    createdAt: "2026-10-07T09:12:34+09:00",
    ...over,
  });
  const store = createMemoryStore();

  it("共有先と記録の口が揃い、回答あり・Discord 引用なしのときだけ true", () => {
    const cfg = { shareChannelId: "S", sharedAnswers: store };
    expect(canOfferShare(cfg, q())).toBe(true);
    expect(canOfferShare({ sharedAnswers: store }, q())).toBe(false);
    expect(canOfferShare({ shareChannelId: "S" }, q())).toBe(false);
    expect(canOfferShare(cfg, undefined)).toBe(false);
    expect(canOfferShare(cfg, q({ answerStatus: "unanswered" }))).toBe(false);
    expect(canOfferShare(cfg, q({ answer: null }))).toBe(false);
    expect(
      canOfferShare(cfg, q({ sourcesJson: JSON.stringify([{ kind: "discord", url: "x" }]) })),
    ).toBe(false);
  });

  it("JST の記録時刻を短く表示する(形が違えばそのまま)", () => {
    expect(formatRecordedAt("2026-10-07T09:12:34+09:00")).toBe("2026-10-07 09:12 JST");
    expect(formatRecordedAt("unknown")).toBe("unknown");
  });
});
