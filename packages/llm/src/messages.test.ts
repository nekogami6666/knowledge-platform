import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmError } from "./errors.js";
import {
  generateStructured,
  type MessagesParseFn,
  type ParseResponse,
  parseMessageResponse,
} from "./messages.js";
import { modelIdFor } from "./models.js";
import type { Usage, UsageRecorder } from "./usage.js";

const schema = z.object({ reasoning: z.string(), level: z.number() });

const baseOpts = {
  app: "evals",
  role: "deep" as const,
  systemPrompt: "sys",
  userContent: "u",
  outputSchema: schema,
};

function recorderSpy(): { recorder: UsageRecorder; records: { app: string; usage: Usage }[] } {
  const records: { app: string; usage: Usage }[] = [];
  return {
    records,
    recorder: { record: (e) => records.push({ app: e.app, usage: e.usage }) },
  };
}

const parseOk =
  (parsed: unknown, usage: ParseResponse["usage"]): MessagesParseFn =>
  async () => ({ parsed_output: parsed, usage });

const parseThrows =
  (err: unknown): MessagesParseFn =>
  async () => {
    throw err;
  };

/** instanceof チェック用に実 SDK エラーのプロトタイプを使う(client は構築しない=キー不要)。 */
function sdkError<T extends object>(proto: T, status?: number): unknown {
  const e = Object.create(proto) as { status?: number; message?: string };
  if (status !== undefined) e.status = status;
  e.message = "sdk error";
  return e;
}

describe("generateStructured", () => {
  it("success の parsed_output を zod 検証して value/usage を返し usage を記録する", async () => {
    const { recorder, records } = recorderSpy();
    const res = await generateStructured(baseOpts, {
      parseFn: parseOk({ reasoning: "ok", level: 2 }, { input_tokens: 5, output_tokens: 7 }),
      usage: recorder,
    });
    expect(res.value).toEqual({ reasoning: "ok", level: 2 });
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ app: "evals" });
  });

  it("parsed_output が null なら STRUCTURED_PARSE(usage は記録済み)", async () => {
    const { recorder, records } = recorderSpy();
    await expect(
      generateStructured(baseOpts, {
        parseFn: parseOk(null, { input_tokens: 3, output_tokens: 0 }),
        usage: recorder,
      }),
    ).rejects.toMatchObject({ code: "STRUCTURED_PARSE" });
    expect(records).toHaveLength(1); // null チェック前に記録(§7.3)
  });

  it("parsed_output がスキーマ不一致なら STRUCTURED_PARSE", async () => {
    await expect(
      generateStructured(baseOpts, { parseFn: parseOk({ level: "x" }, null) }),
    ).rejects.toMatchObject({ code: "STRUCTURED_PARSE" });
  });

  it("RateLimitError は RATE_LIMITED(throw 時 usage 未記録)", async () => {
    const { recorder, records } = recorderSpy();
    await expect(
      generateStructured(baseOpts, {
        parseFn: parseThrows(sdkError(Anthropic.RateLimitError.prototype, 429)),
        usage: recorder,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(records).toHaveLength(0);
  });

  it("APIError status 529 は OVERLOADED", async () => {
    await expect(
      generateStructured(baseOpts, {
        parseFn: parseThrows(sdkError(Anthropic.APIError.prototype, 529)),
      }),
    ).rejects.toMatchObject({ code: "OVERLOADED" });
  });

  it("APIConnectionTimeoutError は TIMEOUT", async () => {
    await expect(
      generateStructured(baseOpts, {
        parseFn: parseThrows(sdkError(Anthropic.APIConnectionTimeoutError.prototype)),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("APIError status 408 は TIMEOUT", async () => {
    await expect(
      generateStructured(baseOpts, {
        parseFn: parseThrows(sdkError(Anthropic.APIError.prototype, 408)),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("その他の APIError(500)は API_ERROR", async () => {
    await expect(
      generateStructured(baseOpts, {
        parseFn: parseThrows(sdkError(Anthropic.APIError.prototype, 500)),
      }),
    ).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("非 APIError の throw は API_ERROR", async () => {
    await expect(
      generateStructured(baseOpts, { parseFn: parseThrows(new Error("boom")) }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("params/timeout を正しく組む(モデルID解決・adaptive thinking・禁止パラメータ無し)", async () => {
    let captured: Record<string, unknown> | undefined;
    let capturedOpts: { timeout: number } | undefined;
    const parseFn: MessagesParseFn = async (params, options) => {
      captured = params;
      capturedOpts = options;
      return { parsed_output: { reasoning: "r", level: 1 }, usage: null };
    };
    await generateStructured({ ...baseOpts, effort: "low" }, { parseFn });
    expect(captured?.model).toBe(modelIdFor("deep"));
    expect(captured?.max_tokens).toBe(1024);
    expect(captured?.thinking).toEqual({ type: "adaptive" });
    expect("budget_tokens" in (captured ?? {})).toBe(false);
    expect("temperature" in (captured ?? {})).toBe(false);
    expect("top_p" in (captured ?? {})).toBe(false);
    // system / messages の trust boundary 配線(§9.5: system は信頼、user は単一 DATA ターン)。
    expect(captured?.system).toBe("sys");
    expect(captured?.messages).toEqual([{ role: "user", content: "u" }]);
    // output_config.format は json_schema 型で、zodToJsonSchema が schema を埋めている。
    const oc = captured?.output_config as {
      format?: { type?: string; schema?: { properties?: Record<string, unknown> } };
      effort?: string;
    };
    expect(oc.format).toMatchObject({ type: "json_schema" });
    expect(oc.format?.schema?.properties).toMatchObject({ reasoning: {}, level: {} });
    expect(oc.effort).toBe("low");
    expect(capturedOpts?.timeout).toBe(60_000);
  });

  it("thinking:false なら thinking を省略する", async () => {
    let captured: Record<string, unknown> | undefined;
    const parseFn: MessagesParseFn = async (params) => {
      captured = params;
      return { parsed_output: { reasoning: "r", level: 0 }, usage: null };
    };
    await generateStructured({ ...baseOpts, thinking: false }, { parseFn });
    expect("thinking" in (captured ?? {})).toBe(false);
  });
});

describe("parseMessageResponse", () => {
  const usage = { input_tokens: 1, output_tokens: 2 };

  it("text ブロックのみを連結して JSON.parse する", () => {
    const r = parseMessageResponse({
      content: [{ type: "text", text: '{"level":2}' }],
      usage,
    });
    expect(r.parsed_output).toEqual({ level: 2 });
    expect(r.usage).toEqual(usage);
  });

  it("thinking ブロックは無視し text のみ使う", () => {
    const r = parseMessageResponse({
      content: [
        { type: "thinking", text: "悩み中..." },
        { type: "text", text: '{"level":1}' },
      ],
      usage,
    });
    expect(r.parsed_output).toEqual({ level: 1 });
  });

  it("複数 text ブロックは順に連結する", () => {
    const r = parseMessageResponse({
      content: [
        { type: "text", text: '{"a":1,' },
        { type: "text", text: '"b":2}' },
      ],
      usage,
    });
    expect(r.parsed_output).toEqual({ a: 1, b: 2 });
  });

  it("空 content は parsed_output=null(refusal / 切り詰め)", () => {
    expect(parseMessageResponse({ content: [], usage }).parsed_output).toBeNull();
  });

  it("不正な JSON は parsed_output=null", () => {
    expect(
      parseMessageResponse({ content: [{ type: "text", text: "not json" }], usage }).parsed_output,
    ).toBeNull();
  });

  it("usage=null はそのまま通す", () => {
    const r = parseMessageResponse({ content: [{ type: "text", text: "{}" }], usage: null });
    expect(r.usage).toBeNull();
  });
});
