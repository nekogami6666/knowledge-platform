import { describe, expect, it } from "vitest";
import { MODELS, type ModelRole, modelIdFor } from "./models.js";

describe("modelIdFor", () => {
  it("各ロールが非空のモデル ID を返す", () => {
    for (const role of ["fast", "standard", "deep", "qa"] as ModelRole[]) {
      expect(modelIdFor(role).length).toBeGreaterThan(0);
    }
  });

  it("ロール対応を保つ(素のモデルID・standard は ADR-0039 追記 D4 で sonnet-5-5)", () => {
    expect(modelIdFor("fast")).toBe("claude-haiku-4-5-20251001");
    expect(modelIdFor("standard")).toBe("claude-sonnet-5-5");
    expect(modelIdFor("deep")).toBe("claude-opus-4-8");
  });

  it("qa(/ask の回答生成)は claude-sonnet-5-5(ADR-0039・standard とは別ロールのまま)", () => {
    expect(modelIdFor("qa")).toBe("claude-sonnet-5-5");
  });

  it("MODELS は fast / standard / deep / qa の 4 ロールちょうどを持つ", () => {
    expect(Object.keys(MODELS).sort()).toEqual(["deep", "fast", "qa", "standard"]);
  });
});
