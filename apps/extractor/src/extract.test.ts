import { type AgentSearchOptions, LlmError, type PromptStore } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import { type ExtractionResult, extractionResultSchema } from "./candidate.js";
import {
  buildExtractPrompt,
  type ExtractSearchFn,
  extractFromMinutes,
  numberLines,
} from "./extract.js";

const fakePromptStore: PromptStore = {
  read: async () => "---\nrole: standard\n---\nEXTRACT RULES",
};

const minutes = {
  repo: "org/minutes",
  path: "2026/06/2026-06-10-hw-weekly.md",
  content: "# HW 定例\n湿度しきい値を 40%RH 以下に更新する。",
  cwd: "/tmp/clone",
};

const empty: ExtractionResult = { decisions: [], learnings: [], openQuestions: [] };

function fakeSearch(value: ExtractionResult) {
  const captured: { opts?: AgentSearchOptions<ExtractionResult> } = {};
  const search: ExtractSearchFn = async (opts) => {
    captured.opts = opts;
    return { value, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { search, captured };
}

describe("numberLines", () => {
  it("各行に L{n}: を付ける(1 始まり)", () => {
    expect(numberLines("a\nb")).toBe("L1: a\nL2: b");
  });
});

describe("buildExtractPrompt", () => {
  it("repo/path と行番号付き本文を含む", () => {
    const p = buildExtractPrompt(minutes);
    expect(p).toContain("org/minutes");
    expect(p).toContain("2026/06/2026-06-10-hw-weekly.md");
    expect(p).toContain("L1: # HW 定例");
    expect(p).toContain("40%RH");
  });
  it("existingDomains を提示して再利用を促す", () => {
    const p = buildExtractPrompt(minutes, ["hardware", "firmware"]);
    expect(p).toContain("既存 domain");
    expect(p).toContain("hardware, firmware");
  });
});

describe("extractFromMinutes", () => {
  it("ツール無し単発で抽出(allowedTools:[]・role・app・outputSchema・prompt 由来・本文インライン)", async () => {
    const { search, captured } = fakeSearch({
      ...empty,
      learnings: [
        {
          kind: "learning",
          title: "湿度しきい値",
          body: "40%RH 以下",
          entryType: "fact",
          domain: "hardware",
          people: [],
          tags: [],
          confidence: "high",
        },
      ],
    });
    const r = await extractFromMinutes(minutes, { promptStore: fakePromptStore, search });
    expect(r.value.learnings).toHaveLength(1);
    expect(captured.opts?.allowedTools).toEqual([]);
    expect(captured.opts?.role).toBe("standard");
    expect(captured.opts?.app).toBe("extractor");
    expect(captured.opts?.outputSchema).toBe(extractionResultSchema);
    expect(captured.opts?.systemPrompt).toBe("EXTRACT RULES");
    expect(captured.opts?.prompt).toContain("org/minutes");
    expect(captured.opts?.prompt).toContain("40%RH");
  });

  it("retryable は1回リトライして成功(sleep 注入で即時)", async () => {
    let calls = 0;
    const search: ExtractSearchFn = async () => {
      calls += 1;
      if (calls === 1) throw new LlmError("RATE_LIMITED", "429");
      return { value: empty, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await extractFromMinutes(minutes, {
      promptStore: fakePromptStore,
      search,
      retry: { sleep: async () => {} },
    });
    expect(calls).toBe(2);
    expect(r.value).toEqual(empty);
  });
});
