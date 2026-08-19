import { describe, expect, it } from "vitest";
import { daysOpen, pickReviewer } from "./review.js";

const DAY = 86_400_000;

describe("pickReviewer(日替わりローテーション・㉞ A3)", () => {
  it("anchor の日数 index で選び、同じ日なら時刻に依らず同じ担当", () => {
    expect(pickReviewer(["a", "b"], new Date(DAY * 4))).toBe("a");
    expect(pickReviewer(["a", "b"], new Date(DAY * 5))).toBe("b");
    expect(pickReviewer(["a", "b"], new Date(DAY * 5 + 3_600_000))).toBe("b");
  });

  it("mentions が空なら undefined(メンション無し)", () => {
    expect(pickReviewer([], new Date(DAY * 5))).toBeUndefined();
  });
});

describe("daysOpen", () => {
  const now = new Date("2026-08-20T12:00:00Z");
  it("経過日数を切り捨てで返す", () => {
    expect(daysOpen("2026-08-18T00:00:00Z", now)).toBe(2); // 2.5 日 → 2
    expect(daysOpen("2026-08-20T00:00:00Z", now)).toBe(0);
  });
  it("未来の createdAt(時計ずれ)は 0、読めない日時は null", () => {
    expect(daysOpen("2026-08-21T00:00:00Z", now)).toBe(0);
    expect(daysOpen("not-a-date", now)).toBeNull();
  });
});
