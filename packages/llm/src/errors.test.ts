import { describe, expect, it } from "vitest";
import { LlmError, RETRYABLE_LLM_CODES } from "./errors.js";

describe("LlmError", () => {
  it("Error を継承し name / code / message を保持する", () => {
    const err = new LlmError("API_ERROR", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LlmError");
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toBe("boom");
  });

  it("cause を保持する", () => {
    const cause = new Error("root");
    const err = new LlmError("TIMEOUT", "timed out", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("RETRYABLE_LLM_CODES", () => {
  it("429 / 529 / timeout 系のみを含む", () => {
    expect([...RETRYABLE_LLM_CODES].sort()).toEqual(["OVERLOADED", "RATE_LIMITED", "TIMEOUT"]);
  });
});
