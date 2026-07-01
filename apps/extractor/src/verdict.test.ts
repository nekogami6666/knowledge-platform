import { describe, expect, it } from "vitest";
import { verdictSchema } from "./verdict.js";

describe("verdictSchema", () => {
  it("new を受理(target 無し)", () => {
    expect(verdictSchema.parse({ classification: "new", reason: "該当なし" }).classification).toBe(
      "new",
    );
  });
  it("duplicate を受理(target 付き)", () => {
    const v = verdictSchema.parse({
      classification: "duplicate",
      targetPath: "knowledge/hardware/kb-2026-0142-x.md",
      targetId: "kb-2026-0142",
      reason: "既出",
    });
    expect(v.targetId).toBe("kb-2026-0142");
  });
  it("不明な classification を拒否", () => {
    expect(() => verdictSchema.parse({ classification: "maybe", reason: "x" })).toThrow();
  });
  it("reason は必須", () => {
    expect(() => verdictSchema.parse({ classification: "new" })).toThrow();
  });
  it("strict: 不明キーを拒否", () => {
    expect(() => verdictSchema.parse({ classification: "new", reason: "x", extra: 1 })).toThrow();
  });
});
