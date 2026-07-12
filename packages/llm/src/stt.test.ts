import { describe, expect, it, vi } from "vitest";
import { LlmError } from "./errors.js";
import { STT_MODEL } from "./models.js";
import { createOpenAiTranscriber } from "./stt.js";

/** リトライを即時化(sleep 注入・§7.1)。 */
const fastRetry = { sleep: async () => {} };

function okResponse(text = "こんにちは"): Response {
  return new Response(JSON.stringify({ text }), { status: 200 });
}

function errResponse(status: number, body = "err"): Response {
  return new Response(body, { status });
}

function input(over: Partial<Parameters<ReturnType<typeof createOpenAiTranscriber>>[0]> = {}) {
  return {
    audio: new Uint8Array([1, 2, 3]),
    filename: "memo.ogg",
    contentType: "audio/ogg",
    ...over,
  };
}

describe("createOpenAiTranscriber", () => {
  it("multipart POST を組み立てて text とモデルを返す", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResponse("音声メモの内容です");
    });
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await transcribe(input());
    expect(result).toEqual({ text: "音声メモの内容です", model: STT_MODEL });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const form = call.init.body as FormData;
    expect(form.get("model")).toBe(STT_MODEL);
    expect(form.get("language")).toBe("ja"); // 既定 ja(§7.5)
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("memo.ogg");
    expect(file.size).toBe(3);
  });

  it("model と language を上書きできる(直書きせず設定で差し替え)", async () => {
    let form: FormData | undefined;
    const fetchFn = async (_url: unknown, init?: RequestInit) => {
      form = init?.body as FormData;
      return okResponse();
    };
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      model: "gpt-4o-transcribe-diarize",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const result = await transcribe(input({ language: "en" }));
    expect(result.model).toBe("gpt-4o-transcribe-diarize");
    expect(form?.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(form?.get("language")).toBe("en");
  });

  it("429 はリトライして成功する(§7.1)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, "rate limited"))
      .mockResolvedValueOnce(okResponse("再試行成功"));
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
      retry: { maxRetries: 1, ...fastRetry },
    });
    const result = await transcribe(input());
    expect(result.text).toBe("再試行成功");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("5xx は OVERLOADED としてリトライ対象、上限到達で throw", async () => {
    const fetchFn = vi.fn(async () => errResponse(503, "unavailable"));
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
      retry: { maxRetries: 1, ...fastRetry },
    });
    await expect(transcribe(input())).rejects.toMatchObject({
      name: "LlmError",
      code: "OVERLOADED",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2); // 初回 + リトライ 1 回
  });

  it("4xx(429 以外)は API_ERROR としてリトライしない", async () => {
    const fetchFn = vi.fn(async () => errResponse(400, "bad request"));
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
      retry: { maxRetries: 3, ...fastRetry },
    });
    await expect(transcribe(input())).rejects.toMatchObject({
      name: "LlmError",
      code: "API_ERROR",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("タイムアウトは TIMEOUT に写像する", async () => {
    const timeoutErr = new Error("aborted");
    timeoutErr.name = "TimeoutError";
    const fetchFn = vi.fn(async () => {
      throw timeoutErr;
    });
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
      retry: { maxRetries: 0, ...fastRetry },
    });
    await expect(transcribe(input())).rejects.toMatchObject({
      name: "LlmError",
      code: "TIMEOUT",
    });
  });

  it("ネットワークエラーは API_ERROR に写像する(リトライ対象外)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
      retry: { maxRetries: 3, ...fastRetry },
    });
    await expect(transcribe(input())).rejects.toMatchObject({ code: "API_ERROR" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("応答に text が無ければ STRUCTURED_PARSE(§7.2)", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 }));
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(transcribe(input())).rejects.toMatchObject({ code: "STRUCTURED_PARSE" });
  });

  it("エラー詳細は先頭 200 文字に切り詰める", async () => {
    const fetchFn = vi.fn(async () => errResponse(400, "x".repeat(1000)));
    const transcribe = createOpenAiTranscriber({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(transcribe(input())).rejects.toSatisfy(
      (e: unknown) => e instanceof LlmError && e.message.length < 300,
    );
  });
});
