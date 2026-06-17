import { describe, expect, it } from "vitest";
import { nullUsageRecorder, type Usage, type UsageRecorder } from "./usage.js";

describe("UsageRecorder", () => {
  it("nullUsageRecorder.record は何もせず throw しない", () => {
    expect(() =>
      nullUsageRecorder.record({
        app: "discord-bot",
        role: "standard",
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    ).not.toThrow();
  });

  it("注入したレコーダに app / role / usage がそのまま渡る", () => {
    const calls: Array<{ app: string; role: string; usage: Usage }> = [];
    const recorder: UsageRecorder = {
      record(entry) {
        calls.push(entry);
      },
    };

    recorder.record({ app: "extractor", role: "deep", usage: { inputTokens: 1, outputTokens: 2 } });

    expect(calls).toEqual([
      { app: "extractor", role: "deep", usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
  });
});
