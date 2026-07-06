import { describe, expect, it } from "vitest";
import {
  type AnswerEntryCandidate,
  answerEntryCandidateSchema,
  buildAnswerEntry,
  gapAnswerPayloadSchema,
} from "./answer.js";

const candidate = (over: Partial<AnswerEntryCandidate> = {}): AnswerEntryCandidate => ({
  title: "湿度と脱調",
  entryType: "fact",
  domain: "hardware",
  body: "高湿度で Y 軸が脱調する。",
  confidence: "high",
  ...over,
});

const URL = "https://discord.com/channels/1/2/3";

describe("gapAnswerPayloadSchema", () => {
  it("必須4項目が揃えば通る", () => {
    const p = { questionId: "q-2026-0007", authorId: "U1", content: "答え", messageUrl: URL };
    expect(gapAnswerPayloadSchema.safeParse(p).success).toBe(true);
  });
  it("欠けると失敗", () => {
    const p = { questionId: "q-2026-0007", authorId: "U1", content: "答え" };
    expect(gapAnswerPayloadSchema.safeParse(p).success).toBe(false);
  });
});

describe("answerEntryCandidateSchema", () => {
  it("有効な候補は通る(tags 省略可)", () => {
    expect(answerEntryCandidateSchema.safeParse(candidate()).success).toBe(true);
  });
  it("decision は entryType に選べない(ナレッジ限定)", () => {
    expect(
      answerEntryCandidateSchema.safeParse({ ...candidate(), entryType: "decision" }).success,
    ).toBe(false);
  });
  it("domain は英小文字・数字・ハイフンのみ", () => {
    expect(
      answerEntryCandidateSchema.safeParse({ ...candidate(), domain: "Hardware 検証" }).success,
    ).toBe(false);
  });
});

describe("buildAnswerEntry", () => {
  const now = new Date("2026-07-06T01:00:00Z"); // JST 10:00

  it("KnowledgeEntry に写す(discord 出典・owner・active・JST 日付)", () => {
    const built = buildAnswerEntry("kb-2026-0143", candidate(), URL, "yamada", now);
    expect(built.frontmatter).toMatchObject({
      id: "kb-2026-0143",
      title: "湿度と脱調",
      type: "fact",
      domain: "hardware",
      owner: "yamada",
      people: ["yamada"],
      status: "active",
      confidence: "high",
      created: "2026-07-06",
      last_verified: "2026-07-06",
      sources: [{ kind: "discord", url: URL }],
    });
    expect(built.frontmatter.tags).toEqual([]);
    expect(built.path).toBe("knowledge/hardware/kb-2026-0143-entry.md");
  });

  it("slug は ASCII kebab 化してパスに使う(記号除去)", () => {
    const built = buildAnswerEntry(
      "kb-2026-0143",
      candidate({ slug: "Humidity Destep!" }),
      URL,
      "y",
      now,
    );
    expect(built.path).toBe("knowledge/hardware/kb-2026-0143-humidity-destep.md");
  });

  it("tags を保持する", () => {
    const built = buildAnswerEntry(
      "kb-2026-0143",
      candidate({ tags: ["humidity"] }),
      URL,
      "y",
      now,
    );
    expect(built.frontmatter.tags).toEqual(["humidity"]);
  });
});
