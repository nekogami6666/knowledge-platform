import { describe, expect, it } from "vitest";
import { compareToBaseline, DROP_THRESHOLD } from "./baseline.js";

const base = { citationMatchRate: 0.9, validityRate: 0.8 };

describe("compareToBaseline (§10.2 10pt 低下アラート)", () => {
  it("低下なし(同等/向上)は regressed=false", () => {
    expect(compareToBaseline({ citationMatchRate: 0.9, validityRate: 0.85 }, base).regressed).toBe(
      false,
    );
  });

  it("citationMatchRate が 10pt 以上低下で regressed", () => {
    const r = compareToBaseline({ citationMatchRate: 0.79, validityRate: 0.8 }, base);
    expect(r.regressed).toBe(true);
    expect(r.drops.map((d) => d.metric)).toContain("citationMatchRate");
  });

  it("validityRate の低下も検出する", () => {
    const r = compareToBaseline({ citationMatchRate: 0.9, validityRate: 0.6 }, base);
    expect(r.regressed).toBe(true);
    expect(r.drops.map((d) => d.metric)).toContain("validityRate");
  });

  it("閾値ちょうど(0.10)は低下とみなす(>=)", () => {
    const r = compareToBaseline(
      { citationMatchRate: base.citationMatchRate - DROP_THRESHOLD, validityRate: 0.8 },
      base,
    );
    expect(r.regressed).toBe(true);
  });

  it("閾値未満(0.09)は低下とみなさない", () => {
    const r = compareToBaseline({ citationMatchRate: 0.81, validityRate: 0.8 }, base);
    expect(r.regressed).toBe(false);
  });
});
