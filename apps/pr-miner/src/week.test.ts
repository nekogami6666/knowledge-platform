import { describe, expect, it } from "vitest";
import { isoWeekKey } from "./week.js";

describe("isoWeekKey", () => {
  it("週の木曜が属する年で ISO 週を返す", () => {
    expect(isoWeekKey(new Date("2026-07-09T00:00:00Z"))).toBe("2026-W28");
    expect(isoWeekKey(new Date("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });

  it("年跨ぎ(1/1 が木曜前)は前年の最終週になる", () => {
    // 2027-01-01 は金曜 → ISO 週は 2026-W53(その週の木曜 2026-12-31 が属する年)
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});
