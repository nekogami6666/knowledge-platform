import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AgentQueryFn, runAgentSearch } from "./agent.js";
import { LlmError } from "./errors.js";
import type { Usage, UsageRecorder } from "./usage.js";

const schema = z.object({ answer: z.string(), notFound: z.boolean() });

/** params を無視して与えたメッセージ列を流す疑似 query()。 */
function streamOf(...messages: unknown[]): AgentQueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

const baseOpts = {
  app: "discord-bot",
  role: "standard" as const,
  systemPrompt: "sys",
  prompt: "q",
  cwd: "/tmp/clones",
  outputSchema: schema,
};

describe("runAgentSearch", () => {
  it("success の structured_output を zod 検証して value/usage を返す", async () => {
    const queryFn = streamOf({
      type: "result",
      subtype: "success",
      structured_output: { answer: "A", notFound: false },
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    const recorded: Array<{ app: string }> = [];
    const usage: UsageRecorder = { record: (e) => recorded.push(e) };

    const res = await runAgentSearch(baseOpts, { queryFn, usage });

    expect(res.value).toEqual({ answer: "A", notFound: false });
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(recorded).toHaveLength(1);
  });

  it("structured_output がスキーマ不一致なら STRUCTURED_PARSE", async () => {
    const queryFn = streamOf({
      type: "result",
      subtype: "success",
      structured_output: { answer: 123 },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(runAgentSearch(baseOpts, { queryFn })).rejects.toMatchObject({
      code: "STRUCTURED_PARSE",
    });
  });

  it("error_max_budget_usd は BUDGET_EXCEEDED", async () => {
    const queryFn = streamOf({ type: "result", subtype: "error_max_budget_usd" });
    await expect(runAgentSearch(baseOpts, { queryFn })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("error_max_structured_output_retries は STRUCTURED_PARSE", async () => {
    const queryFn = streamOf({ type: "result", subtype: "error_max_structured_output_retries" });
    await expect(runAgentSearch(baseOpts, { queryFn })).rejects.toMatchObject({
      code: "STRUCTURED_PARSE",
    });
  });

  it("result メッセージが無ければ API_ERROR", async () => {
    const queryFn = streamOf({ type: "assistant" });
    await expect(runAgentSearch(baseOpts, { queryFn })).rejects.toMatchObject({
      code: "API_ERROR",
    });
  });

  it("usage は error result でも記録する(§7.3)", async () => {
    const queryFn = streamOf({
      type: "result",
      subtype: "error_during_execution",
      usage: { input_tokens: 2, output_tokens: 3 },
    });
    const recorded: Array<{ usage: Usage }> = [];
    const usage: UsageRecorder = { record: (e) => recorded.push(e) };

    await expect(runAgentSearch(baseOpts, { queryFn, usage })).rejects.toBeInstanceOf(LlmError);
    expect(recorded[0]?.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  });

  it("タイムアウト(abort)で TIMEOUT を投げる", async () => {
    vi.useFakeTimers();
    try {
      // next() が abort シグナルでのみ reject する疑似ストリーム(何も yield しない)。
      const queryFn: AgentQueryFn = ({ options }) => ({
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<unknown>> =>
            new Promise((_resolve, reject) => {
              options.abortController?.signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        }),
      });
      const p = runAgentSearch({ ...baseOpts, timeoutMs: 1000 }, { queryFn });
      // タイマー前進前に reject ハンドラを装着しておく(未処理 rejection 回避)。
      const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort 以外の理由で throw すれば API_ERROR", async () => {
    // next() が即 reject する(abort ではない)疑似ストリーム。
    const queryFn: AgentQueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => Promise.reject(new Error("network boom")),
      }),
    });
    await expect(runAgentSearch(baseOpts, { queryFn })).rejects.toMatchObject({
      code: "API_ERROR",
    });
  });
});
