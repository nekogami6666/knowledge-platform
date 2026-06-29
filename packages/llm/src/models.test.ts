import { describe, expect, it } from "vitest";
import { MODELS, type ModelRole, modelIdFor } from "./models.js";

describe("modelIdFor", () => {
  it("各ロールが非空のモデル ID を返す", () => {
    for (const role of ["fast", "standard", "deep"] as ModelRole[]) {
      expect(modelIdFor(role).length).toBeGreaterThan(0);
    }
  });

  it("design.md §5.2 のロール対応を保つ(素のモデルID)", () => {
    expect(modelIdFor("fast")).toBe("claude-haiku-4-5-20251001");
    expect(modelIdFor("standard")).toBe("claude-sonnet-4-6");
    expect(modelIdFor("deep")).toBe("claude-opus-4-8");
  });

  it("MODELS は fast / standard / deep の 3 ロールちょうどを持つ", () => {
    expect(Object.keys(MODELS).sort()).toEqual(["deep", "fast", "standard"]);
  });
});
