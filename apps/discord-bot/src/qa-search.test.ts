import { LlmError } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import { type AgentSearchFn, createQaSearch, DEFAULT_ASK_TIMEOUT_MS } from "./qa-search.js";

const INPUT = { systemPrompt: "SYS", question: "Q", cwd: "/clones" };
const ANSWER = {
  value: { answer: "A", citations: [], notFound: false },
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe("createQaSearch(タイムアウトの明示・㉞ 失敗耐性)", () => {
  it("既定 600s を明示的に渡し、deps.timeoutMs で上書きできる", async () => {
    const seen: (number | undefined)[] = [];
    const runSearch = (async (opts: { timeoutMs?: number }) => {
      seen.push(opts.timeoutMs);
      return ANSWER;
    }) as unknown as AgentSearchFn;
    await createQaSearch({ runSearch })(INPUT);
    await createQaSearch({ runSearch, timeoutMs: 300_000 })(INPUT);
    expect(seen).toEqual([600_000, 300_000]);
    expect(DEFAULT_ASK_TIMEOUT_MS).toBe(600_000); // §6.2「上限 600 秒」の正典値ピン(ADR-0035 D1)
  });

  it("TIMEOUT はリトライしない(再送は 15 分の interaction 期限内の待ち時間を倍にするだけ)", async () => {
    let calls = 0;
    const runSearch = (async () => {
      calls += 1;
      throw new LlmError("TIMEOUT", "timeout");
    }) as unknown as AgentSearchFn;
    await expect(createQaSearch({ runSearch })(INPUT)).rejects.toThrow("timeout");
    expect(calls).toBe(1);
  });

  it("onProgress を runAgentSearch の opts へ透過する(ADR-0035 D5)", async () => {
    let seen: unknown;
    const runSearch = (async (opts: { onProgress?: unknown }) => {
      seen = opts.onProgress;
      return ANSWER;
    }) as unknown as AgentSearchFn;
    const onProgress = () => {};
    await createQaSearch({ runSearch })({ ...INPUT, onProgress });
    expect(seen).toBe(onProgress);
    await createQaSearch({ runSearch })(INPUT);
    expect(seen).toBeUndefined();
  });
});
