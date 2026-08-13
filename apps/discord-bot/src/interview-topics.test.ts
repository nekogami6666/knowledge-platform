import { describe, expect, it } from "vitest";
import { loadInterviewTopics, MAX_TOPIC_OPTIONS } from "./interview-topics.js";

function fakeLogger(): { logger: { warn: (...args: unknown[]) => void }; warns: unknown[][] } {
  const warns: unknown[][] = [];
  return {
    logger: {
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    },
    warns,
  };
}

function expertiseYaml(topicCount: number): string {
  const topics = Array.from({ length: topicCount }, (_, i) =>
    [
      `  - topic: "topic-${String(i + 1).padStart(2, "0")}"`,
      `    label: "テーマ ${i + 1}"`,
      "    people:",
      '      - name: "山田"',
      "        evidence_count: 3",
      '        last_active: "2026-07-01"',
      "    bus_factor: 1",
      "    documented_kb_count: 2",
      '    risk: "high"',
    ].join("\n"),
  ).join("\n");
  return `generated_at: "2026-08-01T12:00:00+09:00"\ntopics:\n${topics}\n`;
}

describe("loadInterviewTopics(expertise.yaml → StringSelectMenu 候補)", () => {
  it("topics を {value: topic キー, label} へ写す(kbCloneDir 配下の expertise/expertise.yaml を読む)", async () => {
    const asked: string[] = [];
    const { logger, warns } = fakeLogger();
    const options = await loadInterviewTopics(
      async (p) => {
        asked.push(p);
        return expertiseYaml(2);
      },
      "/clones/knowledge-base",
      logger,
    );
    expect(asked).toEqual(["/clones/knowledge-base/expertise/expertise.yaml"]);
    expect(options).toEqual([
      { value: "topic-01", label: "テーマ 1" },
      { value: "topic-02", label: "テーマ 2" },
    ]);
    expect(warns).toHaveLength(0);
  });

  it("25 件以上は 24 件に切り詰める(25 枠目は「その他」用)", async () => {
    const { logger } = fakeLogger();
    const options = await loadInterviewTopics(async () => expertiseYaml(30), "/kb", logger);
    expect(options).toHaveLength(MAX_TOPIC_OPTIONS);
    expect(options[0]?.value).toBe("topic-01");
    expect(options[23]?.value).toBe("topic-24");
  });

  it("ファイル欠落は [] + 警告で続行する(パネルは自由入力のみで動く)", async () => {
    const { logger, warns } = fakeLogger();
    const options = await loadInterviewTopics(
      async () => {
        throw new Error("ENOENT");
      },
      "/kb",
      logger,
    );
    expect(options).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it("parse 失敗(スキーマ違反)は [] + 警告で続行する", async () => {
    const { logger, warns } = fakeLogger();
    const options = await loadInterviewTopics(
      async () => 'generated_at: "2026-08-01T12:00:00+09:00"\ntopics:\n  - topic: ""\n',
      "/kb",
      logger,
    );
    expect(options).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it("YAML 構文の破損も [] + 警告で続行する", async () => {
    const { logger, warns } = fakeLogger();
    const options = await loadInterviewTopics(async () => "topics: [::broken", "/kb", logger);
    expect(options).toEqual([]);
    expect(warns).toHaveLength(1);
  });
});
