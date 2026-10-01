import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AgentQueryFn,
  buildAgentEnv,
  createContainmentHook,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  isModelSubstituted,
  runAgentSearch,
  sanitizeModelUsage,
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

  it("result の num_turns / duration_api_ms を numTurns / durationApiMs に転記する(ADR-0035 D4)", async () => {
    const queryFn = streamOf({
      type: "result",
      subtype: "success",
      structured_output: { answer: "A", notFound: false },
      usage: { input_tokens: 1, output_tokens: 1 },
      num_turns: 12,
      duration_api_ms: 34_567,
    });
    const res = await runAgentSearch(baseOpts, { queryFn });
    expect(res.numTurns).toBe(12);
    expect(res.durationApiMs).toBe(34_567);
    // 無い場合はキー自体を持たない(呼び出し側の `?? null` で観測できる)。
    const res2 = await runAgentSearch(baseOpts, {
      queryFn: streamOf({
        type: "result",
        subtype: "success",
        structured_output: { answer: "A", notFound: false },
      }),
    });
    expect("numTurns" in res2).toBe(false);
  });

  it("assistant メッセージの tool_use をツール名と通番だけで onProgress に流す(ADR-0035 D5)", async () => {
    const queryFn = streamOf(
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "探します" },
            { type: "tool_use", name: "Grep", input: { pattern: "秘密" } },
            { type: "tool_use", name: "Glob", input: { pattern: "**/*.md" } },
          ],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
      {
        type: "result",
        subtype: "success",
        structured_output: { answer: "A", notFound: false },
      },
    );
    const events: unknown[] = [];
    const res = await runAgentSearch(
      {
        ...baseOpts,
        onProgress: (ev) => {
          events.push(ev);
          if (events.length === 1) throw new Error("listener が壊れていても検索は続く");
        },
      },
      { queryFn },
    );
    expect(res.value.answer).toBe("A");
    expect(events).toEqual([
      { kind: "tool_use", tool: "Grep", turn: 1 },
      { kind: "tool_use", tool: "Glob", turn: 1 },
      { kind: "tool_use", tool: "Read", turn: 2 },
    ]);
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

  describe("呼び出し側の中断(signal・ADR-0035 追記)", () => {
    /** next() が内部 abortController の abort でのみ reject する疑似ストリーム。 */
    const hangingQuery = (): { queryFn: AgentQueryFn; started: () => number } => {
      let started = 0;
      const queryFn: AgentQueryFn = ({ options }) => {
        started += 1;
        return {
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<unknown>> =>
              new Promise((_resolve, reject) => {
                options.abortController?.signal.addEventListener("abort", () =>
                  reject(new Error("aborted")),
                );
              }),
          }),
        };
      };
      return { queryFn, started: () => started };
    };

    it("検索中に signal が abort されたら ABORTED(TIMEOUT ではない)", async () => {
      const { queryFn } = hangingQuery();
      const ctl = new AbortController();
      const p = runAgentSearch({ ...baseOpts, timeoutMs: 60_000, signal: ctl.signal }, { queryFn });
      const assertion = expect(p).rejects.toMatchObject({ code: "ABORTED" });
      ctl.abort();
      await assertion;
    });

    it("開始前に abort 済みなら query() を呼ばずに ABORTED", async () => {
      const { queryFn, started } = hangingQuery();
      const ctl = new AbortController();
      ctl.abort();
      await expect(
        runAgentSearch({ ...baseOpts, signal: ctl.signal }, { queryFn }),
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(started()).toBe(0);
    });

    it("signal を渡してもタイムアウトは従来どおり TIMEOUT", async () => {
      vi.useFakeTimers();
      try {
        const { queryFn } = hangingQuery();
        const ctl = new AbortController();
        const p = runAgentSearch({ ...baseOpts, timeoutMs: 1000, signal: ctl.signal }, { queryFn });
        const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it("SDK が abort で例外を投げずに反復を終えても ABORTED として扱う", async () => {
      const ctl = new AbortController();
      const queryFn: AgentQueryFn = () =>
        (async function* () {
          ctl.abort();
          yield { type: "assistant", message: { content: [] } };
        })();
      await expect(
        runAgentSearch({ ...baseOpts, signal: ctl.signal }, { queryFn }),
      ).rejects.toMatchObject({ code: "ABORTED" });
    });
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

  it("effort / thinking は指定時だけ Options に載り、未指定ならキー自体が無い(ADR-0035 D6)", async () => {
    const seen: Options[] = [];
    const queryFn: AgentQueryFn = ({ options }) => {
      if (options) seen.push(options);
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
    await runAgentSearch(
      { ...baseOpts, effort: "low", thinking: "disabled", maxTurns: 12 },
      { queryFn },
    );
    await runAgentSearch({ ...baseOpts, thinking: "adaptive" }, { queryFn });
    expect("effort" in (seen[0] ?? {})).toBe(false);
    expect("thinking" in (seen[0] ?? {})).toBe(false);
    expect(seen[0]?.maxTurns).toBe(30);
    expect(seen[1]?.effort).toBe("low");
    expect(seen[1]?.thinking).toEqual({ type: "disabled" });
    expect(seen[1]?.maxTurns).toBe(12);
    expect(seen[2]?.thinking).toEqual({ type: "adaptive" });
    // ノブを足しても §9.5 の封じ込めは不変。
    expect(seen[1]?.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS]);
    expect(seen[1]?.permissionMode).toBe("dontAsk");
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
    // ADR-0037: 基本ツール集合を allowedTools に絞り、読み取りを cwd 配下に閉じ込める 2 層を必ず渡す。
    expect(captured?.tools).toEqual([...DEFAULT_ALLOWED_TOOLS]);
    expect(captured?.settings).toEqual({
      permissions: { blockReadsOutsideWorkingDirectories: true },
    });
    expect(captured?.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    // 到達範囲を広げうるオプションは未設定のまま(§9.5)。
    expect(captured?.additionalDirectories).toBeUndefined();
    expect(captured?.canUseTool).toBeUndefined();
    expect(captured?.mcpServers).toBeUndefined();
    expect(captured?.managedSettings).toBeUndefined();
  });

  it("ADR-0037: allowedTools:[](ツール無し単発)は tools:[] でファイル系ツールを基本集合から外す", async () => {
    let captured: Options | undefined;
    const queryFn: AgentQueryFn = ({ options }) => {
      captured = options;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          structured_output: { answer: "A", notFound: false },
        };
      })();
    };
    await runAgentSearch({ ...baseOpts, allowedTools: [] }, { queryFn });
    expect(captured?.tools).toEqual([]);
    expect(captured?.allowedTools).toEqual([]);
  });

  it("ADR-0037: result.permission_denials の件数を deniedToolCalls に転記する", async () => {
    const res = await runAgentSearch(baseOpts, {
      queryFn: streamOf({
        type: "result",
        subtype: "success",
        structured_output: { answer: "A", notFound: false },
        permission_denials: [{ tool_name: "Read" }, { tool_name: "Glob" }],
      }),
    });
    expect(res.deniedToolCalls).toBe(2);
    const res2 = await runAgentSearch(baseOpts, {
      queryFn: streamOf({
        type: "result",
        subtype: "success",
        structured_output: { answer: "A", notFound: false },
      }),
    });
    expect("deniedToolCalls" in res2).toBe(false);
  });

  it("ADR-0037: 渡した hook は cwd 外の Read を deny し、cwd 内は判定を委ねる(allow を返さない)", async () => {
    let captured: Options | undefined;
    const queryFn: AgentQueryFn = ({ options }) => {
      captured = options;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          structured_output: { answer: "A", notFound: false },
        };
      })();
    };
    await runAgentSearch(baseOpts, { queryFn });
    const hook = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeDefined();
    if (hook === undefined) return;
    const signal = new AbortController().signal;
    const pre = (tool_name: string, tool_input: unknown) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input,
          tool_use_id: "t1",
          session_id: "s",
          transcript_path: "/dev/null",
          cwd: baseOpts.cwd,
        } as Parameters<typeof hook>[0],
        "t1",
        { signal },
      );
    await expect(pre("Read", { file_path: "/config/ops.yaml" })).resolves.toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    await expect(pre("Read", { file_path: `${baseOpts.cwd}/repo/a.md` })).resolves.toEqual({});
    await expect(pre("StructuredOutput", { answer: "A" })).resolves.toEqual({});
  });
});

describe("createContainmentHook(ADR-0037)", () => {
  const signal = new AbortController().signal;
  const input = (tool_name: string, tool_input: unknown) =>
    ({
      hook_event_name: "PreToolUse",
      tool_name,
      tool_input,
      tool_use_id: "t1",
      session_id: "s",
      transcript_path: "/dev/null",
      cwd: "/clones",
    }) as Parameters<ReturnType<typeof createContainmentHook>>[0];

  it("realpath の想定外失敗(code 無しの例外)は deny(fail-closed)", async () => {
    let calls = 0;
    const flaky = (p: string): string => {
      calls += 1;
      if (calls === 1) return p; // root 解決は成功
      throw new Error("boom"); // code 無し = 想定外
    };
    const hook = createContainmentHook("/clones", flaky);
    await expect(
      hook(input("Read", { file_path: "/clones/a.md" }), "t1", { signal }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("PreToolUse 以外のイベントには何も返さない", async () => {
    const hook = createContainmentHook("/clones", (p) => p);
    const ev = { ...input("Read", {}), hook_event_name: "PostToolUse" } as unknown as Parameters<
      typeof hook
    >[0];
    await expect(hook(ev, "t1", { signal })).resolves.toEqual({});
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

describe("実モデルの記録と会話記録の非保存(2026-10-01「test」回答の不具合対策)", () => {
  const success = {
    type: "result",
    subtype: "success",
    structured_output: { answer: "A", notFound: false },
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it("最初の assistant メッセージの model を actualModel に、指定モデルを requestedModel に入れる", async () => {
    const res = await runAgentSearch(baseOpts, {
      queryFn: streamOf(
        { type: "system", subtype: "init", model: "claude-sonnet-4-6" },
        { type: "assistant", message: { model: "claude-sonnet-5", content: [] } },
        { type: "assistant", message: { model: "other", content: [] } },
        success,
      ),
    });
    expect(res.actualModel).toBe("claude-sonnet-5");
    expect(typeof res.requestedModel).toBe("string");
    expect(res.requestedModel?.length).toBeGreaterThan(0);
  });

  it("assistant メッセージが無ければ actualModel を持たない", async () => {
    const res = await runAgentSearch(baseOpts, { queryFn: streamOf(success) });
    expect("actualModel" in res).toBe(false);
  });

  it("persistSession: false を SDK に渡す(検索した社内文書を含む会話記録を残さない)", async () => {
    let seen: Options | undefined;
    const queryFn: AgentQueryFn = ({ options }) => {
      seen = options;
      return streamOf(success)({ prompt: "", options });
    };
    await runAgentSearch(baseOpts, { queryFn });
    expect(seen?.persistSession).toBe(false);
  });

  it("isModelSubstituted: 前方一致なら同一、違えば置き換え、どちらか不明なら false", () => {
    expect(isModelSubstituted("claude-sonnet-5-5", "claude-sonnet-5-5")).toBe(false);
    expect(isModelSubstituted("claude-sonnet-5-5", "claude-sonnet-5-5-20260901")).toBe(false);
    expect(isModelSubstituted("claude-sonnet-4-6", "claude-sonnet-5")).toBe(true);
    expect(isModelSubstituted("claude-sonnet-4-6", undefined)).toBe(false);
    expect(isModelSubstituted(undefined, "claude-sonnet-5")).toBe(false);
  });
});

describe("SDK の使用量・費用の転記(段階 1-1 計測)", () => {
  it("cache_creation / cache_read / total_cost_usd / modelUsage を結果に載せる(input_tokens とは別計上)", async () => {
    const res = await runAgentSearch(baseOpts, {
      queryFn: streamOf({
        type: "result",
        subtype: "success",
        structured_output: { answer: "A", notFound: false },
        usage: {
          input_tokens: 12,
          output_tokens: 340,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 42_000,
        },
        total_cost_usd: 0.1234,
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 12,
            outputTokens: 340,
            cacheReadInputTokens: 42_000,
            cacheCreationInputTokens: 5000,
            webSearchRequests: 0,
            costUSD: 0.1234,
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
            provider: "anthropicAws",
            costBasis: "list",
          },
        },
      }),
    });
    // input_tokens はキャッシュ分を含まない(usage はそのまま・キャッシュは別フィールド)。
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 340 });
    expect(res.cacheCreationInputTokens).toBe(5000);
    expect(res.cacheReadInputTokens).toBe(42_000);
    expect(res.totalCostUsd).toBe(0.1234);
    // 数値以外(provider・costBasis)と観測に不要な数値(contextWindow 等)は落とす。
    expect(res.modelUsage).toEqual({
      "claude-sonnet-4-6": {
        inputTokens: 12,
        outputTokens: 340,
        cacheReadInputTokens: 42_000,
        cacheCreationInputTokens: 5000,
        costUsd: 0.1234,
      },
    });
  });

  it("result に無ければキー自体を持たない(旧 SDK・差し替え)", async () => {
    const res = await runAgentSearch(baseOpts, {
      queryFn: streamOf({
        type: "result",
        subtype: "success",
        structured_output: { answer: "A", notFound: false },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    for (const k of [
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
      "totalCostUsd",
      "modelUsage",
    ]) {
      expect(k in res).toBe(false);
    }
  });

  it("sanitizeModelUsage: 形が違えば undefined、欠けた・非数値のフィールドは 0", () => {
    expect(sanitizeModelUsage(undefined)).toBeUndefined();
    expect(sanitizeModelUsage([])).toBeUndefined();
    expect(sanitizeModelUsage({})).toBeUndefined();
    expect(sanitizeModelUsage({ m: null })).toBeUndefined();
    expect(
      sanitizeModelUsage({ m: { inputTokens: "x", costUSD: Number.NaN, outputTokens: 3 } }),
    ).toEqual({
      m: {
        inputTokens: 0,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      },
    });
  });
});
