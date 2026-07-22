import { describe, expect, it } from "vitest";
import { type ExtractorState, parseState, readState, serializeState } from "./cursor.js";

const STATE: ExtractorState = {
  sources: {
    minutes: { last_processed_sha: "abc123" },
    interviews: { last_processed_sha: "def456" },
  },
  last_run_at: "2026-07-01T00:00:00.000Z",
};

describe("cursor state", () => {
  it("serialize → parse で round-trip", () => {
    expect(parseState(serializeState(STATE))).toEqual(STATE);
  });
  it("pending 付き round-trip(ADR-0023 D2)", () => {
    const withPending: ExtractorState = {
      sources: {
        minutes: { last_processed_sha: "abc123", pending: ["a.md", "b.md"] },
        interviews: { last_processed_sha: "def456" },
      },
      last_run_at: "2026-07-01T00:00:00.000Z",
    };
    expect(parseState(serializeState(withPending))).toEqual(withPending);
  });
  it("pending は未知キーを許さない(strict 維持)", () => {
    const extra = JSON.stringify({
      sources: { minutes: { last_processed_sha: "abc123", bogus: 1 } },
      last_run_at: "2026-07-01T00:00:00.000Z",
    });
    expect(() => parseState(extra)).toThrow();
  });
  it("旧形式(単一 last_processed_sha)は minutes カーソルへ移行して読む(PR-I1 後方互換)", () => {
    const legacy = JSON.stringify({
      last_processed_sha: "abc123",
      last_run_at: "2026-07-01T00:00:00.000Z",
    });
    expect(parseState(legacy)).toEqual({
      sources: { minutes: { last_processed_sha: "abc123" } },
      last_run_at: "2026-07-01T00:00:00.000Z",
    });
  });
  it("readState: ファイル欠落は null(初回)", async () => {
    const r = await readState("/nope", async () => {
      throw new Error("ENOENT");
    });
    expect(r).toBeNull();
  });
  it("readState: 正常読み取り", async () => {
    expect(await readState("/x", async () => serializeState(STATE))).toEqual(STATE);
  });
});
