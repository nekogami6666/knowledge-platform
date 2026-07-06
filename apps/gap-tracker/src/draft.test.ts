import { type AgentSearchOptions, LlmError, type PromptStore } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import { type AnswerEntryCandidate, answerEntryCandidateSchema } from "./answer.js";
import { buildDraftPrompt, type DraftSearchFn, draftEntry } from "./draft.js";

const fakePromptStore: PromptStore = {
  read: async () => "---\nrole: standard\n---\nENTRY RULES",
};

const input = {
  question: "分注ロボットは高湿度で何が起きる?",
  answer: "Y 軸が脱調します。40%RH 以下に保つ必要があります。",
  cwd: "/tmp/kb",
};

const candidate: AnswerEntryCandidate = {
  title: "高湿度と Y 軸脱調",
  entryType: "fact",
  domain: "hardware",
  body: "40%RH 以下に保つ。",
  confidence: "high",
};

function fakeSearch(value: AnswerEntryCandidate) {
  const captured: { opts?: AgentSearchOptions<AnswerEntryCandidate> } = {};
  const search: DraftSearchFn = async (opts) => {
    captured.opts = opts;
    return { value, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { search, captured };
}

describe("buildDraftPrompt", () => {
  it("質問と回答を本文にインラインで含む", () => {
    const p = buildDraftPrompt(input);
    expect(p).toContain("分注ロボット");
    expect(p).toContain("Y 軸が脱調");
    expect(p).toContain("既存 domain: (まだ無し");
  });
  it("existingDomains を提示して再利用を促す", () => {
    const p = buildDraftPrompt({ ...input, existingDomains: ["hardware", "firmware"] });
    expect(p).toContain("hardware, firmware");
  });
});

describe("draftEntry", () => {
  it("ツール無し単発で草案(allowedTools:[]・role・app・outputSchema・prompt 由来)", async () => {
    const { search, captured } = fakeSearch(candidate);
    const r = await draftEntry(input, { promptStore: fakePromptStore, search });
    expect(r.value).toEqual(candidate);
    expect(captured.opts?.allowedTools).toEqual([]);
    expect(captured.opts?.role).toBe("standard");
    expect(captured.opts?.app).toBe("gap-tracker");
    expect(captured.opts?.outputSchema).toBe(answerEntryCandidateSchema);
    expect(captured.opts?.systemPrompt).toBe("ENTRY RULES");
    expect(captured.opts?.prompt).toContain("Y 軸が脱調");
  });

  it("retryable は1回リトライして成功(sleep 注入で即時)", async () => {
    let calls = 0;
    const search: DraftSearchFn = async () => {
      calls += 1;
      if (calls === 1) throw new LlmError("RATE_LIMITED", "429");
      return { value: candidate, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await draftEntry(input, {
      promptStore: fakePromptStore,
      search,
      retry: { sleep: async () => {} },
    });
    expect(calls).toBe(2);
    expect(r.value).toEqual(candidate);
  });
});
