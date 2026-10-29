import type { QaSearch, QaSearchInput } from "@stratum/discord-bot/qa";
import { LlmError } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import { distOf, runAskBench, summarizeBench } from "./bench-ask.js";
import type { GoldenQa } from "./golden.js";

const golden: GoldenQa[] = ["gq-a", "gq-b", "gq-c"].map((id) => ({
  id,
  question: `質問 ${id}`,
  expected_sources: [],
  answer_points: [],
  not_found: false,
}));

describe("distOf", () => {
  it("平均・中央値(偶数個は中央 2 つの平均)・最大。空なら null", () => {
    expect(distOf([])).toBeNull();
    expect(distOf([30, 10, 20])).toEqual({ mean: 20, p50: 20, max: 30 });
    expect(distOf([1, 4, 2, 3])).toEqual({ mean: 2.5, p50: 2.5, max: 4 });
  });
});

describe("runAskBench(実 API を使わない差し替え検索で)", () => {
  it("先頭 limit 問を本番と同じ system prompt で流し、所要時間・ツール利用・費用(全試行)を行にする", async () => {
    const inputs: QaSearchInput[] = [];
    const search: QaSearch = async (input) => {
      inputs.push(input);
      input.onAttempt?.({ inputTokens: 1, outputTokens: 1, totalCostUsd: 0.25 });
      if (input.question.endsWith("gq-b"))
        throw new LlmError("TIMEOUT", "社内パス /x/y を含む本文");
      input.onAttempt?.({ inputTokens: 1, outputTokens: 1, totalCostUsd: 0.5 });
      return {
        value: { answer: "a", citations: [], notFound: true },
        usage: { inputTokens: 1, outputTokens: 1 },
        numTurns: 4,
        startupMs: 900,
        toolCalls: { Grep: 2, Read: 1 },
        parallelTurns: 1,
      };
    };
    let t = 0;
    const rows = await runAskBench(
      {
        golden,
        limit: 2,
        systemPrompt: { systemPrompt: "本文", systemPromptDynamic: "## 対応表" },
        corpusDir: "/corpus",
      },
      { search, monotonicMs: () => (t += 1000) },
    );
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      systemPrompt: "本文",
      systemPromptDynamic: "## 対応表",
      cwd: "/corpus",
    });
    expect(rows[0]).toEqual({
      id: "gq-a",
      elapsedMs: 1000,
      attempts: 2,
      citations: 0,
      notFound: true,
      numTurns: 4,
      startupMs: 900,
      toolCalls: { Grep: 2, Read: 1 },
      parallelTurns: 1,
      costUsd: 0.75,
    });
    // 失敗はエラー名・コードだけ(message は出さない)。失敗回の費用も残す。
    expect(rows[1]).toEqual({
      id: "gq-b",
      elapsedMs: 1000,
      attempts: 1,
      error: "LlmError:TIMEOUT",
      costUsd: 0.25,
    });
    expect(JSON.stringify(rows)).not.toContain("社内パス");
    expect(JSON.stringify(rows)).not.toContain("質問");

    const s = summarizeBench(rows);
    expect(s).toMatchObject({
      questions: 2,
      errors: 1,
      notFound: 1,
      elapsedMs: { mean: 1000, p50: 1000, max: 1000 },
      numTurns: { mean: 4, p50: 4, max: 4 },
      toolCalls: { Grep: 2, Read: 1 },
      parallelTurns: 1,
      totalCostUsd: 1,
    });
  });
});
