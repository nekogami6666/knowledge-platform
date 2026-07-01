import { describe, expect, it } from "vitest";
import { parseState, readState, serializeState } from "./cursor.js";

describe("cursor state", () => {
  it("serialize → parse で round-trip", () => {
    const s = { last_processed_sha: "abc123", last_run_at: "2026-07-01T00:00:00.000Z" };
    expect(parseState(serializeState(s))).toEqual(s);
  });
  it("readState: ファイル欠落は null(初回)", async () => {
    const r = await readState("/nope", async () => {
      throw new Error("ENOENT");
    });
    expect(r).toBeNull();
  });
  it("readState: 正常読み取り", async () => {
    const s = { last_processed_sha: "d1", last_run_at: "2026-07-01T00:00:00.000Z" };
    expect(await readState("/x", async () => serializeState(s))).toEqual(s);
  });
});
