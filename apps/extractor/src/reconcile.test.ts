import type { AgentSearchOptions, PromptStore } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import type { LearningCandidate, OpenQuestionCandidate } from "./candidate.js";
import { candidateSummary, type ReconcileSearchFn, reconcileCandidate } from "./reconcile.js";
import { type Verdict, verdictSchema } from "./verdict.js";

const fakePromptStore: PromptStore = {
  read: async () => "---\nrole: standard\n---\nRECONCILE RULES",
};

const learning: LearningCandidate = {
  kind: "learning",
  title: "湿度しきい値",
  body: "40%RH 以下",
  entryType: "fact",
  domain: "hardware",
  people: [],
  tags: [],
  confidence: "high",
};
const question: OpenQuestionCandidate = {
  kind: "open_question",
  title: "温度補正?",
  body: "未確認",
};

function fakeSearch(value: Verdict) {
  const captured: { opts?: AgentSearchOptions<Verdict> } = {};
  let calls = 0;
  const search: ReconcileSearchFn = async (opts) => {
    calls += 1;
    captured.opts = opts;
    return { value, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { search, captured, calls: () => calls };
}

describe("candidateSummary", () => {
  it("learning は種別/ドメイン/内容を含む", () => {
    const s = candidateSummary(learning);
    expect(s).toContain("ドメイン: hardware");
    expect(s).toContain("40%RH");
  });
});

describe("reconcileCandidate", () => {
  it("open_question は LLM を呼ばず new(D2)", async () => {
    const { search, calls } = fakeSearch({ classification: "duplicate", reason: "x" });
    const r = await reconcileCandidate(question, "/kb", { promptStore: fakePromptStore, search });
    expect(r.value.classification).toBe("new");
    expect(calls()).toBe(0);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("learning は KB を探索して verdict を返す(既定 allowedTools・cwd・role・outputSchema・prompt)", async () => {
    const { search, captured } = fakeSearch({
      classification: "duplicate",
      targetPath: "knowledge/hardware/kb-2026-0142-x.md",
      targetId: "kb-2026-0142",
      reason: "既出",
    });
    const r = await reconcileCandidate(learning, "/kb", { promptStore: fakePromptStore, search });
    expect(r.value.classification).toBe("duplicate");
    // 既定 allowedTools(Read/Grep/Glob)を使う=明示指定しない
    expect(captured.opts?.allowedTools).toBeUndefined();
    expect(captured.opts?.cwd).toBe("/kb");
    expect(captured.opts?.role).toBe("standard");
    expect(captured.opts?.app).toBe("extractor");
    expect(captured.opts?.outputSchema).toBe(verdictSchema);
    expect(captured.opts?.prompt).toContain("湿度しきい値");
  });
});
