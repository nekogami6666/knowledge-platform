import { describe, expect, it, vi } from "vitest";
import { LlmError } from "./errors.js";
import { withRetry } from "./retry.js";

const noSleep = (): Promise<void> => Promise.resolve();

describe("withRetry", () => {
  it("初回成功ならそのまま返す", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("RATE_LIMITED はリトライし、最終的に成功する", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LlmError("RATE_LIMITED", "429"))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("OVERLOADED / TIMEOUT もリトライ対象", async () => {
    for (const code of ["OVERLOADED", "TIMEOUT"] as const) {
      const fn = vi.fn().mockRejectedValueOnce(new LlmError(code, code)).mockResolvedValue("ok");
      await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("リトライ対象外(API_ERROR)は即 throw する", async () => {
    const fn = vi.fn().mockRejectedValue(new LlmError("API_ERROR", "boom"));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toBeInstanceOf(LlmError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maxRetries 到達で最後のエラーを throw する(初回 + maxRetries 回呼ぶ)", async () => {
    const fn = vi.fn().mockRejectedValue(new LlmError("RATE_LIMITED", "429"));
    await expect(withRetry(fn, { maxRetries: 2, sleep: noSleep })).rejects.toBeInstanceOf(LlmError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("指数バックオフで sleep 時間が倍々に増える", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = vi.fn().mockRejectedValue(new LlmError("RATE_LIMITED", "429"));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 100, sleep })).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(delays).toEqual([100, 200, 400]);
  });

  it("maxDelayMs でバックオフが頭打ちになる", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = vi.fn().mockRejectedValue(new LlmError("RATE_LIMITED", "429"));
    await expect(
      withRetry(fn, { maxRetries: 4, baseDelayMs: 100, maxDelayMs: 250, sleep }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(delays).toEqual([100, 200, 250, 250]);
  });
});
