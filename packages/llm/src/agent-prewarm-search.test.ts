/**
 * runAgentSearch の事前起動経路(ADR-0042)。SDK の prewarm() は deps 経由の疑似 spare に差し替え、
 * プロセス内ツールの委譲を確かめるため createSdkMcpServer だけを「渡されたツール定義を返す」形にモックする。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AgentPrewarmFn,
  type AgentQueryFn,
  type AgentSpareProcess,
  createAgentPrewarmPool,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  defineInProcessTool,
  IN_PROCESS_MCP_SERVER,
  runAgentSearch,
} from "./agent.js";
import { modelIdFor } from "./models.js";

const sdkPrewarm = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...orig,
    // 実 SDK の prewarm は呼ばれてはならない(フラグ OFF・注入時)。
    prewarm: sdkPrewarm,
    createSdkMcpServer: (o: { name: string; tools?: unknown[] }) => ({
      type: "sdk",
      name: o.name,
      instance: {},
      tools: o.tools ?? [],
    }),
  };
});

const schema = z.object({ answer: z.string(), notFound: z.boolean() });
const success = {
  type: "result",
  subtype: "success",
  structured_output: { answer: "A", notFound: false },
  usage: { input_tokens: 1, output_tokens: 1 },
};

const root = mkdtempSync(join(tmpdir(), "prewarm-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const baseOpts = {
  app: "discord-bot",
  role: "qa" as const,
  systemPrompt: "sys",
  systemPromptDynamic: "## 対応表",
  prompt: "q",
  cwd: root,
  outputSchema: schema,
};

/** 毎回 success を返す疑似 query()(呼ばれた回数と Options を記録)。 */
function coldQuery(): { queryFn: AgentQueryFn; calls: Options[] } {
  const calls: Options[] = [];
  return {
    calls,
    queryFn: ({ options }) => {
      calls.push(options);
      return (async function* () {
        yield { type: "system", subtype: "init" };
        yield success;
      })();
    },
  };
}

interface FakeSpare extends AgentSpareProcess {
  options: Options;
  claims: Array<{ prompt: string; options: { cwd: string; appendSystemPrompt?: string } }>;
  closed: number;
}

/**
 * 疑似 prewarm()。claimed の結果と、claim 後に流すメッセージ列(spare を受け取る関数)を差し替えられる。
 */
function fakePrewarm(
  behavior: {
    claimed?: () => Promise<unknown>;
    stream?: (spare: FakeSpare) => AsyncIterable<unknown>;
  } = {},
): { prewarmFn: AgentPrewarmFn; spares: FakeSpare[] } {
  const spares: FakeSpare[] = [];
  const prewarmFn: AgentPrewarmFn = async ({ options }) => {
    let claimedPromise: Promise<unknown> = new Promise(() => {});
    const spare: FakeSpare = {
      options,
      claims: [],
      closed: 0,
      exited: new Promise(() => {}),
      get claimed() {
        return claimedPromise;
      },
      claim(params) {
        spare.claims.push(params);
        claimedPromise = behavior.claimed?.() ?? Promise.resolve({ cwd: params.options.cwd });
        claimedPromise.catch(() => {});
        return (
          behavior.stream?.(spare) ??
          (async function* () {
            yield { type: "system", subtype: "init" };
            yield success;
          })()
        );
      },
      close() {
        spare.closed += 1;
      },
    };
    spares.push(spare);
    return spare;
  };
  return { prewarmFn, spares };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** spare の Options から PreToolUse hook を取り出し、ツール呼び出し 1 件を判定させる。 */
function preToolUse(options: Options) {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  return (tool_name: string, tool_input: unknown) =>
    hook(
      {
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input,
        tool_use_id: "t1",
        session_id: "s",
        transcript_path: "/dev/null",
        cwd: "/somewhere",
      } as Parameters<HookCallback>[0],
      "t1",
      { signal: new AbortController().signal },
    );
}

const DENY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } };
/** toEqual の中で使う deny の照合(理由の文面は問わない)。 */
const denied = () =>
  expect.objectContaining({
    hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }),
  });

/** モックした createSdkMcpServer が受け取ったツール定義(handler を直接呼べる)。 */
function mcpToolsOf(options: Options) {
  const server = options.mcpServers?.[IN_PROCESS_MCP_SERVER] as unknown as {
    tools: Array<{
      name: string;
      handler: (
        args: unknown,
        extra: unknown,
      ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    }>;
  };
  return server.tools;
}

beforeEach(() => {
  sdkPrewarm.mockReset();
});

describe("runAgentSearch の事前起動(ADR-0042)", () => {
  it("フラグ OFF(deps.prewarm 無し)は従来どおり query() だけで、prewarm を呼ばず prewarmed:false", async () => {
    const { queryFn, calls } = coldQuery();
    const res = await runAgentSearch(baseOpts, { queryFn });
    const res2 = await runAgentSearch(baseOpts, { queryFn });
    expect(calls).toHaveLength(2);
    expect(res.prewarmed).toBe(false);
    expect(res2.prewarmed).toBe(false);
    expect(sdkPrewarm).not.toHaveBeenCalled();
  });

  it("最初の 1 件は従来経路で検索し、終わったら同じ封じ込め設定の spare を 1 本用意する", async () => {
    const { queryFn, calls } = coldQuery();
    const { prewarmFn, spares } = fakePrewarm();
    const pool = createAgentPrewarmPool({ prewarmFn });
    const res = await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    expect(res.prewarmed).toBe(false);
    expect(calls).toHaveLength(1);
    await flush();
    expect(pool.state()).toBe("ready");
    expect(spares).toHaveLength(1);
    const o = spares[0]?.options as Options;
    // cwd は claim で渡す(spawn 時は SDK の待機用ディレクトリ)。対応表も claim で足す。
    expect("cwd" in o).toBe(false);
    expect(o.systemPrompt).toEqual(["sys", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"]);
    // ADR-0037 / §9.5 の不変条件は従来経路と同じ。
    expect(o.model).toBe(modelIdFor("qa"));
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.tools).toEqual([...DEFAULT_ALLOWED_TOOLS]);
    expect(o.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS]);
    expect(o.disallowedTools).toEqual([...DEFAULT_DISALLOWED_TOOLS]);
    expect(o.settings).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(o.outputFormat).toEqual(calls[0]?.outputFormat);
    expect(o.env).toEqual(calls[0]?.env);
    expect(o.env !== undefined && "DISCORD_TOKEN" in o.env).toBe(false);
    expect(o.canUseTool).toBeUndefined();
    expect(o.additionalDirectories).toBeUndefined();
    expect(o.abortController).toBeInstanceOf(AbortController);
    await pool.dispose();
  });

  it("2 件目は待機中の spare を claim し(cwd・対応表を渡す)、使い終えたら閉じて次の 1 本を用意する", async () => {
    const { queryFn, calls } = coldQuery();
    const { prewarmFn, spares } = fakePrewarm();
    const pool = createAgentPrewarmPool({ prewarmFn });
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    await flush();
    const ticks = [500, 520];
    const res = await runAgentSearch(baseOpts, {
      queryFn,
      prewarm: pool,
      monotonicMs: () => ticks.shift() ?? 999,
    });
    expect(calls).toHaveLength(1); // query() は 1 件目だけ
    expect(res.prewarmed).toBe(true);
    expect(res.value.answer).toBe("A");
    // startupMs は claim から最初のメッセージまで。
    expect(res.startupMs).toBe(20);
    expect(spares[0]?.claims).toEqual([
      { prompt: "q", options: { cwd: root, appendSystemPrompt: "## 対応表" } },
    ]);
    expect(spares[0]?.closed).toBeGreaterThan(0);
    await flush();
    expect(spares).toHaveLength(2);
    expect(pool.state()).toBe("ready");
    await pool.dispose();
    expect(spares[1]?.closed).toBe(1);
  });

  it("SDK が起動時に process.env へ書く CLAUDE_AGENT_SDK_VERSION の有無では spare を捨てない", async () => {
    const prev = process.env.CLAUDE_AGENT_SDK_VERSION;
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    try {
      const calls: Options[] = [];
      const queryFn: AgentQueryFn = ({ options }) => {
        calls.push(options);
        // 実 SDK の query() と同じく、起動のたびに書き込む。
        process.env.CLAUDE_AGENT_SDK_VERSION = "0.3.285";
        return (async function* () {
          yield success;
        })();
      };
      const { prewarmFn } = fakePrewarm();
      const pool = createAgentPrewarmPool({ prewarmFn });
      await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
      await flush();
      const res = await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
      expect(res.prewarmed).toBe(true);
      expect(calls).toHaveLength(1);
      await pool.dispose();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION;
      else process.env.CLAUDE_AGENT_SDK_VERSION = prev;
    }
  });

  it("subprocess env(認証情報など)が変われば spare を捨てて従来経路", async () => {
    const { queryFn, calls } = coldQuery();
    const { prewarmFn, spares } = fakePrewarm();
    const pool = createAgentPrewarmPool({ prewarmFn });
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    await flush();
    const prev = process.env.ANTHROPIC_PREWARM_TEST_ROTATED;
    process.env.ANTHROPIC_PREWARM_TEST_ROTATED = "new";
    try {
      const res = await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
      expect(res.prewarmed).toBe(false);
      expect(calls).toHaveLength(2);
      expect(spares[0]?.closed).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_PREWARM_TEST_ROTATED;
      else process.env.ANTHROPIC_PREWARM_TEST_ROTATED = prev;
      await pool.dispose();
    }
  });

  it("対応表が空なら appendSystemPrompt を渡さない", async () => {
    const { queryFn } = coldQuery();
    const { prewarmFn, spares } = fakePrewarm();
    const pool = createAgentPrewarmPool({ prewarmFn });
    const opts = { ...baseOpts, systemPromptDynamic: "" };
    await runAgentSearch(opts, { queryFn, prewarm: pool });
    await flush();
    await runAgentSearch(opts, { queryFn, prewarm: pool });
    expect(spares[0]?.claims[0]?.options).toEqual({ cwd: root });
    await pool.dispose();
  });

  it("prewarm が失敗したら従来経路で検索し、警告は 1 回だけ", async () => {
    const { queryFn, calls } = coldQuery();
    const warns: Array<Record<string, unknown>> = [];
    const pool = createAgentPrewarmPool({
      prewarmFn: async () => {
        throw new Error("prewarm boom");
      },
      onWarn: (data) => warns.push(data),
    });
    for (let i = 0; i < 3; i++) {
      const res = await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
      expect(res.prewarmed).toBe(false);
      await flush();
    }
    expect(calls).toHaveLength(3);
    expect(warns.filter((w) => w.kind === "prewarm_failed")).toHaveLength(1);
    await pool.dispose();
  });

  it("claim が拒否されたら spare を閉じて従来経路で検索する(prompt は二重に走らない)", async () => {
    const { queryFn, calls } = coldQuery();
    const warns: Array<Record<string, unknown>> = [];
    const { prewarmFn, spares } = fakePrewarm({
      claimed: () => Promise.reject(new Error("cwd_not_found: the claim cwd does not exist")),
      // 拒否された spare の Query は読まない(読めば失敗する)。
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<unknown>> =>
            Promise.reject(new Error("拒否された spare の Query は読まない")),
        }),
      }),
    });
    const pool = createAgentPrewarmPool({ prewarmFn, onWarn: (data) => warns.push(data) });
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    await flush();
    const res = await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    expect(res.prewarmed).toBe(false);
    expect(res.value.answer).toBe("A");
    expect(calls).toHaveLength(2);
    expect(spares[0]?.closed).toBeGreaterThan(0);
    expect(warns).toEqual([
      expect.objectContaining({ kind: "claim_refused", reason: "cwd_not_found" }),
    ]);
    await pool.dispose();
  });

  it("構成(静的な system prompt 等)が spare と違えば spare を閉じて従来経路", async () => {
    const { queryFn, calls } = coldQuery();
    const { prewarmFn, spares } = fakePrewarm();
    const pool = createAgentPrewarmPool({ prewarmFn });
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    await flush();
    const res = await runAgentSearch(
      { ...baseOpts, systemPrompt: "sys v2" },
      { queryFn, prewarm: pool },
    );
    expect(res.prewarmed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(spares[0]?.claims).toHaveLength(0);
    expect(spares[0]?.closed).toBe(1);
    // 次の 1 本は新しい構成で用意する。
    await flush();
    expect(spares[1]?.options.systemPrompt).toEqual([
      "sys v2",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
    ]);
    await pool.dispose();
  });

  it("ADR-0037: spare の hook は claim した cwd の外を deny し、claim の外ではすべて deny する", async () => {
    const { queryFn } = coldQuery();
    const seen: Array<{ phase: string; out: unknown }> = [];
    const { prewarmFn, spares } = fakePrewarm({
      stream: (spare) =>
        (async function* () {
          const pre = preToolUse(spare.options);
          seen.push({ phase: "outside", out: await pre("Read", { file_path: "/etc/hostname" }) });
          seen.push({ phase: "dotdot", out: await pre("Read", { file_path: `${root}/../x` }) });
          seen.push({ phase: "inside", out: await pre("Read", { file_path: `${root}/a.md` }) });
          seen.push({ phase: "glob", out: await pre("Glob", { pattern: "/etc/*" }) });
          seen.push({ phase: "structured", out: await pre("StructuredOutput", { answer: "A" }) });
          yield success;
        })(),
    });
    const pool = createAgentPrewarmPool({ prewarmFn });
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    await flush();
    const spare = spares[0] as FakeSpare;
    // claim 前: 判定ルートが無いので cwd 内でも deny(fail-closed)。
    await expect(
      preToolUse(spare.options)("Read", { file_path: `${root}/a.md` }),
    ).resolves.toMatchObject(DENY);
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    expect(seen).toEqual([
      { phase: "outside", out: denied() },
      { phase: "dotdot", out: denied() },
      { phase: "inside", out: {} },
      { phase: "glob", out: denied() },
      { phase: "structured", out: {} },
    ]);
    // 終了後: 参照が外れて再びすべて deny。
    await expect(
      preToolUse(spare.options)("Read", { file_path: `${root}/a.md` }),
    ).resolves.toMatchObject(DENY);
    await pool.dispose();
  });

  it("ADR-0038 D6: spare の discord_search は claim した呼び出しの handler にだけ委ね、claim の外では拒否する", async () => {
    const { queryFn } = coldQuery();
    const handlerA = vi.fn(async () => "A の範囲の結果");
    const handlerB = vi.fn(async (args: { query: string }) => `B の範囲の結果: ${args.query}`);
    const toolFor = (handler: (args: { query: string }) => Promise<string>) =>
      defineInProcessTool({
        name: "discord_search",
        description: "テスト用",
        inputShape: { query: z.string().min(1) },
        handler,
      });
    const during: unknown[] = [];
    const { prewarmFn, spares } = fakePrewarm({
      stream: (spare) =>
        (async function* () {
          const [t] = mcpToolsOf(spare.options);
          during.push(await t?.handler({ query: "勤怠" }, {}));
          yield success;
        })(),
    });
    const pool = createAgentPrewarmPool({ prewarmFn });
    // 1 件目(質問者 A・従来経路)。spare には定義だけが写る。
    await runAgentSearch(
      { ...baseOpts, inProcessTools: [toolFor(handlerA)] },
      {
        queryFn,
        prewarm: pool,
      },
    );
    await flush();
    const spare = spares[0] as FakeSpare;
    expect(spare.options.allowedTools).toContain("mcp__stratum__discord_search");
    const [delegate] = mcpToolsOf(spare.options);
    // claim 前: 何も実行せずに拒否する(A の handler も呼ばない)。
    await expect(delegate?.handler({ query: "x" }, {})).resolves.toEqual({
      content: [{ type: "text", text: "このツールは現在使えません" }],
      isError: true,
    });
    // 2 件目(質問者 B)が claim: B の handler だけが呼ばれる。
    const res = await runAgentSearch(
      { ...baseOpts, inProcessTools: [toolFor(handlerB)] },
      { queryFn, prewarm: pool },
    );
    expect(res.prewarmed).toBe(true);
    expect(during).toEqual([{ content: [{ type: "text", text: "B の範囲の結果: 勤怠" }] }]);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA).not.toHaveBeenCalled();
    // 終了後: 再び拒否。
    await expect(delegate?.handler({ query: "x" }, {})).resolves.toMatchObject({ isError: true });
    expect(handlerB).toHaveBeenCalledTimes(1);
    await pool.dispose();
  });

  it("ツールの有無が spare と違う呼び出しは spare を使わない(定義の不一致)", async () => {
    const { queryFn, calls } = coldQuery();
    const { prewarmFn } = fakePrewarm();
    const pool = createAgentPrewarmPool({ prewarmFn });
    const t = defineInProcessTool({
      name: "discord_search",
      description: "テスト用",
      inputShape: { query: z.string() },
      handler: async () => "",
    });
    await runAgentSearch({ ...baseOpts, inProcessTools: [t] }, { queryFn, prewarm: pool });
    await flush();
    const res = await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    expect(res.prewarmed).toBe(false);
    expect(calls).toHaveLength(2);
    await pool.dispose();
  });

  it("claim 中に呼び出し側が中断したら ABORTED にし、次の spare は用意しない(終了処理中)", async () => {
    const { queryFn } = coldQuery();
    const ctl = new AbortController();
    const { prewarmFn, spares } = fakePrewarm({
      stream: (spare) =>
        (async function* () {
          yield { type: "system", subtype: "init" };
          ctl.abort();
          // SDK は spare 固有の controller の abort で反復を例外終了する。
          if (spare.options.abortController?.signal.aborted) throw new Error("aborted");
          yield success;
        })(),
    });
    const pool = createAgentPrewarmPool({ prewarmFn });
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    await flush();
    await expect(
      runAgentSearch({ ...baseOpts, signal: ctl.signal }, { queryFn, prewarm: pool }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await flush();
    expect(spares).toHaveLength(1);
    expect(spares[0]?.closed).toBeGreaterThan(0);
    await pool.dispose();
  });

  it("待機が idleMs を超えたら spare を閉じ、次の 1 件は従来経路(その後また用意する)", async () => {
    const { queryFn, calls } = coldQuery();
    const { prewarmFn, spares } = fakePrewarm();
    let fireIdle: (() => void) | undefined;
    const pool = createAgentPrewarmPool({
      prewarmFn,
      idleMs: 1_800_000,
      setTimer: (fn, ms) => {
        if (ms === 1_800_000) fireIdle = fn;
        return setTimeout(() => {}, 0);
      },
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    await flush();
    expect(pool.state()).toBe("ready");
    fireIdle?.();
    expect(spares[0]?.closed).toBe(1);
    expect(pool.state()).toBe("empty");
    const res = await runAgentSearch(baseOpts, { queryFn, prewarm: pool });
    expect(res.prewarmed).toBe(false);
    expect(calls).toHaveLength(2);
    await flush();
    expect(pool.state()).toBe("ready");
    await pool.dispose();
    expect(pool.state()).toBe("disposed");
  });
});
