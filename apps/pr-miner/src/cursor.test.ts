import { describe, expect, it } from "vitest";
import { parseState, readState, serializeState } from "./cursor.js";

describe("cursor round-trip", () => {
  it("serialize → parse で往復する", () => {
    const state = {
      repos: { "org/a": { last_merged_at: "2026-07-05T00:00:00Z" } },
      last_run_at: "2026-07-09T00:00:00Z",
    };
    expect(parseState(serializeState(state))).toEqual(state);
  });

  it("末尾改行付き 2 スペース整形(diff 安定)", () => {
    const s = serializeState({ repos: {}, last_run_at: "2026-07-09T00:00:00Z" });
    expect(s.endsWith("}\n")).toBe(true);
    expect(s).toContain('  "repos"');
  });

  it("未知キーは strict で拒否", () => {
    expect(() => parseState('{"repos":{},"last_run_at":"x","nope":1}')).toThrow();
  });
});

describe("readState", () => {
  it("存在しない/壊れは null(初回)", async () => {
    expect(
      await readState("/x", async () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(await readState("/x", async () => "not json")).toBeNull();
  });

  it("正常な JSON を読む", async () => {
    const raw = serializeState({
      repos: { "org/a": { last_merged_at: "2026-07-05T00:00:00Z" } },
      last_run_at: "2026-07-09T00:00:00Z",
    });
    const s = await readState("/x", async () => raw);
    expect(s?.repos["org/a"]?.last_merged_at).toBe("2026-07-05T00:00:00Z");
  });
});
