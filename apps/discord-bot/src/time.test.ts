import { describe, expect, it } from "vitest";
import { isoJst } from "./time.js";

describe("isoJst (§7.5: JST +09:00 の ISO 8601)", () => {
  it("UTC を +09:00 表記に変換する", () => {
    expect(isoJst(new Date("2026-06-17T01:00:00Z"))).toBe("2026-06-17T10:00:00+09:00");
  });

  it("日付跨ぎ(UTC 22:00 → 翌日 JST 07:00)", () => {
    expect(isoJst(new Date("2026-06-17T22:00:00Z"))).toBe("2026-06-18T07:00:00+09:00");
  });
});
