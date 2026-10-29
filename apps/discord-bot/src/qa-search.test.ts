import { createAgentPrewarmPool, LlmError } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import {
  type AgentSearchFn,
  createQaSearch,
  DEFAULT_ASK_TIMEOUT_MS,
  shouldRetryAsk,
} from "./qa-search.js";

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

  it("prewarm(ADR-0042)は渡したときだけ runAgentSearch の deps に載せる(未指定なら従来どおり)", async () => {
    const seen: unknown[] = [];
    const runSearch = (async (_opts: unknown, deps?: Record<string, unknown>) => {
      seen.push(deps);
      return ANSWER;
    }) as unknown as AgentSearchFn;
    const prewarm = createAgentPrewarmPool({
      prewarmFn: async () => {
        throw new Error("使われない");
      },
    });
    await createQaSearch({ runSearch })(INPUT);
    await createQaSearch({ runSearch, prewarm })(INPUT);
    expect(seen[0]).not.toHaveProperty("prewarm");
    expect(seen[1]).toHaveProperty("prewarm", prewarm);
    await prewarm.dispose();
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

  it("signal を runAgentSearch の opts へ透過し、ABORTED は再試行しない(ADR-0035 追記)", async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const runSearch = (async (opts: { signal?: unknown }) => {
      calls += 1;
      seen.push(opts.signal);
      throw new LlmError("ABORTED", "中断");
    }) as unknown as AgentSearchFn;
    const ctl = new AbortController();
    await expect(
      createQaSearch({ runSearch, maxRetries: 1 })({ ...INPUT, signal: ctl.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls).toBe(1);
    expect(seen[0]).toBe(ctl.signal);
    expect(shouldRetryAsk(new LlmError("ABORTED", "x"))).toBe(false);
  });

  it("maxTurns / effort / thinking を指定時だけ透過し、未指定なら opts に載せない(ADR-0035 D6)", async () => {
    const seen: Record<string, unknown>[] = [];
    const runSearch = (async (opts: Record<string, unknown>) => {
      seen.push(opts);
      return ANSWER;
    }) as unknown as AgentSearchFn;
    await createQaSearch({ runSearch })(INPUT);
    await createQaSearch({ runSearch, maxTurns: 20, effort: "medium", thinking: "disabled" })(
      INPUT,
    );
    for (const k of ["maxTurns", "effort", "thinking"]) expect(k in (seen[0] ?? {})).toBe(false);
    expect(seen[1]).toMatchObject({ maxTurns: 20, effort: "medium", thinking: "disabled" });
  });
});

describe("STRUCTURED_PARSE の再試行(2026-10-01「test」回答の不具合対策)", () => {
  it("退化回答・形式崩れ(STRUCTURED_PARSE)は 1 回だけ検索し直し、2 回目の結果を返す", async () => {
    let calls = 0;
    const runSearch = (async () => {
      calls += 1;
      if (calls === 1) throw new LlmError("STRUCTURED_PARSE", "回答本文が成り立っていません");
      return ANSWER;
    }) as unknown as AgentSearchFn;
    await expect(createQaSearch({ runSearch, maxRetries: 1 })(INPUT)).resolves.toEqual(ANSWER);
    expect(calls).toBe(2);
  });

  it("2 回続けて失敗したらそれ以上は再試行せずエラーにする(費用の上限)", async () => {
    let calls = 0;
    const runSearch = (async () => {
      calls += 1;
      throw new LlmError("STRUCTURED_PARSE", "x");
    }) as unknown as AgentSearchFn;
    await expect(createQaSearch({ runSearch, maxRetries: 1 })(INPUT)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("shouldRetryAsk: STRUCTURED_PARSE と過負荷は再試行、TIMEOUT と LlmError 以外はしない", () => {
    expect(shouldRetryAsk(new LlmError("STRUCTURED_PARSE", "x"))).toBe(true);
    expect(shouldRetryAsk(new LlmError("OVERLOADED", "x"))).toBe(true);
    expect(shouldRetryAsk(new LlmError("TIMEOUT", "x"))).toBe(false);
    expect(shouldRetryAsk(new Error("x"))).toBe(false);
  });
});

describe("試行ごとの使用量の通知(段階 1-1: 費用は全試行の合計)", () => {
  it("再試行を含む試行ごとに onAttempt を 1 回呼び、result の使用量(無ければ null)を渡す", async () => {
    let calls = 0;
    const runSearch = (async (opts: { onUsage?: (u: unknown) => void }) => {
      calls += 1;
      if (calls === 1) {
        // 形式エラーの回も result は届いている(費用が発生している)。
        opts.onUsage?.({ inputTokens: 1, outputTokens: 2, totalCostUsd: 0.01 });
        throw new LlmError("STRUCTURED_PARSE", "x");
      }
      opts.onUsage?.({ inputTokens: 3, outputTokens: 4, totalCostUsd: 0.02 });
      return ANSWER;
    }) as unknown as AgentSearchFn;
    const attempts: unknown[] = [];
    await createQaSearch({ runSearch, maxRetries: 1 })({
      ...INPUT,
      onAttempt: (u) => attempts.push(u),
    });
    expect(attempts).toEqual([
      { inputTokens: 1, outputTokens: 2, totalCostUsd: 0.01 },
      { inputTokens: 3, outputTokens: 4, totalCostUsd: 0.02 },
    ]);
  });

  it("result の無い失敗(タイムアウト)は null で通知し、onAttempt が無ければ onUsage も渡さない", async () => {
    const seen: Record<string, unknown>[] = [];
    const runSearch = (async (opts: Record<string, unknown>) => {
      seen.push(opts);
      throw new LlmError("TIMEOUT", "t");
    }) as unknown as AgentSearchFn;
    const attempts: unknown[] = [];
    await expect(
      createQaSearch({ runSearch })({ ...INPUT, onAttempt: (u) => attempts.push(u) }),
    ).rejects.toThrow();
    expect(attempts).toEqual([null]);
    await expect(createQaSearch({ runSearch })(INPUT)).rejects.toThrow();
    expect("onUsage" in (seen[1] ?? {})).toBe(false);
  });
});
