import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AgentQueryFn,
  buildAgentEnv,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  runAgentSearch,
} from "./agent.js";
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

  it("§9.5: query に渡す封じ込めオプションを固定する(危険ツールを決して許可しない)", async () => {
    let captured: Options | undefined;
    const queryFn: AgentQueryFn = ({ options }) => {
      captured = options;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          structured_output: { answer: "A", notFound: false },
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      })();
    };

    await runAgentSearch(baseOpts, { queryFn });

    // 許可ツールは読み取り専用の3つだけ。
    expect(captured?.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS]);
    // 危険ツールは disallowedTools に明示され、allowedTools には決して入らない(回帰防止の核心)。
    expect(captured?.disallowedTools).toEqual(
      expect.arrayContaining([...DEFAULT_DISALLOWED_TOOLS]),
    );
    for (const danger of [
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
    ]) {
      expect(captured?.allowedTools).not.toContain(danger);
    }
    // ヘッドレス・ハーメチック・構造化出力の不変条件。
    expect(captured?.permissionMode).toBe("dontAsk");
    expect(captured?.settingSources).toEqual([]);
    expect(captured?.outputFormat).toMatchObject({ type: "json_schema" });
    // §9.1 / ADR-0006: subprocess env を絞り込み、秘密は渡さない。
    expect(captured?.env).toBeDefined();
    expect(captured?.env && "DISCORD_TOKEN" in captured.env).toBe(false);
  });
});

describe("buildAgentEnv (§9.1 / ADR-0006: subprocess env 絞り込み)", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/bot",
    // Claude on AWS 認証(ADR-0009)。ANTHROPIC_ / CLAUDE_ / AWS_ 接頭辞は素通しする。
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
    ANTHROPIC_AWS_API_KEY: "AEAA-xxx",
    ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_xxx",
    AWS_REGION: "ap-northeast-1",
    DISCORD_TOKEN: "raw-discord",
    GITHUB_TOKEN: "raw-github",
    SOME_OTHER_SECRET: "nope",
  };

  it("許可リスト + ANTHROPIC_/CLAUDE_/AWS_ 接頭辞だけを通す", () => {
    const env = buildAgentEnv(source);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/bot");
    expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBe("1");
    expect(env.ANTHROPIC_AWS_API_KEY).toBe("AEAA-xxx");
    expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_xxx");
    expect(env.AWS_REGION).toBe("ap-northeast-1");
  });

  it("DISCORD_TOKEN / GITHUB_TOKEN / 無関係な秘密は渡さない", () => {
    const env = buildAgentEnv(source);
    expect("DISCORD_TOKEN" in env).toBe(false);
    expect("GITHUB_TOKEN" in env).toBe(false);
    expect("SOME_OTHER_SECRET" in env).toBe(false);
  });

  it("undefined の値は含めない", () => {
    const env = buildAgentEnv({ PATH: undefined, HOME: "/h" });
    expect("PATH" in env).toBe(false);
    expect(env.HOME).toBe("/h");
  });

  it("AWS_/CLAUDE_/ANTHROPIC_ 接頭辞(Claude Platform on AWS 認証)を通す(ADR-0008)", () => {
    const env = buildAgentEnv({
      AWS_REGION: "ap-northeast-1",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      ANTHROPIC_AWS_API_KEY: "AEAA-key",
      ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_xxx",
      DISCORD_TOKEN: "raw-discord",
    });
    expect(env.AWS_REGION).toBe("ap-northeast-1");
    expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBe("1");
    expect(env.ANTHROPIC_AWS_API_KEY).toBe("AEAA-key");
    expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_xxx");
    // 秘密の選別は維持: bot トークンは subprocess へ渡さない。
    expect("DISCORD_TOKEN" in env).toBe(false);
  });
});

// extractStructured は削除(Claude Platform on AWS/第一者とも structured_output が入る。ADR-0008)。
