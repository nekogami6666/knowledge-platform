import { describe, expect, it } from "vitest";
import { formatJstShort, isoJst } from "./time.js";

describe("isoJst (§7.5: JST +09:00 の ISO 8601)", () => {
  it("UTC を +09:00 表記に変換する", () => {
    expect(isoJst(new Date("2026-06-17T01:00:00Z"))).toBe("2026-06-17T10:00:00+09:00");
  });

  it("日付跨ぎ(UTC 22:00 → 翌日 JST 07:00)", () => {
    expect(isoJst(new Date("2026-06-17T22:00:00Z"))).toBe("2026-06-18T07:00:00+09:00");
  });
});

describe("formatJstShort(利用者向けの短い JST 表示)", () => {
  it("M/D HH:mm(月日の先頭ゼロなし・時分は 2 桁)", () => {
    expect(formatJstShort(new Date("2026-10-01T00:12:59Z"))).toBe("10/1 09:12");
    expect(formatJstShort(new Date("2026-06-30T20:05:00Z"))).toBe("7/1 05:05");
  });
});
