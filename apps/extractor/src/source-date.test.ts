import { describe, expect, it } from "vitest";
import { minutesDateFromPath } from "./source-date.js";

const jstDate = (d: Date | null): string | null =>
  d === null ? null : new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

describe("minutesDateFromPath(源泉日・ADR-0026 D3)", () => {
  it("実 dev-minutes 形式(YYYY_MM_DD_from)から日付を取る", () => {
    const d = minutesDateFromPath(
      "meetings/internal/2026/2026-06/2026_06_11_from_18-59_to_19-58_04965085/minutes.md",
    );
    // ディレクトリの 2026-06 より先にフルの日付にマッチさせたいが、正規表現は最初の一致を取る。
    // 2026-06 は日が無いので YYYY[_-]MM[_-]DD の3要素には一致せず、2026_06_11 が取れる。
    expect(jstDate(d)).toBe("2026-06-11");
  });

  it("synthetic 形式(YYYY-MM-DD-... ファイル名)から日付を取る", () => {
    expect(jstDate(minutesDateFromPath("minutes/2026/06/2026-06-03-hw-weekly.md"))).toBe(
      "2026-06-03",
    );
  });

  it("日付が無いパスは null(呼び出し側が now() にフォールバック)", () => {
    expect(minutesDateFromPath("minutes/readme.md")).toBeNull();
    expect(minutesDateFromPath("interviews/kits/tanaka-robotics.md")).toBeNull();
  });

  it("数字並びでも不正な月日(2026_99_99)は null", () => {
    expect(minutesDateFromPath("minutes/2026_99_99_from_x/minutes.md")).toBeNull();
  });

  it("JST 深夜として解釈される(年境界で ID の年とズレない)", () => {
    const d = minutesDateFromPath("minutes/2026/12/2026-12-31-yearend.md");
    expect(jstDate(d)).toBe("2026-12-31");
  });
});
