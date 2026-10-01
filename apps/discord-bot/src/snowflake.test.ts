import { describe, expect, it } from "vitest";
import { compareSnowflake, snowflakeForMs, snowflakeToMs } from "./snowflake.js";

describe("snowflake(ADR-0038)", () => {
  it("時刻 → snowflake → 時刻が往復する", () => {
    const t = Date.UTC(2026, 9, 1, 12, 34, 56, 789);
    expect(snowflakeToMs(snowflakeForMs(t))).toBe(t);
    // 実在の ID 形式(下位 22 bit に worker/seq)でも時刻は同じ。
    expect(snowflakeToMs((BigInt(snowflakeForMs(t)) + 4095n).toString())).toBe(t);
  });

  it("桁数の違う ID を数値として比べる(文字列比較では逆転する)", () => {
    expect(compareSnowflake("99", "100")).toBe(-1);
    expect(compareSnowflake("100", "99")).toBe(1);
    expect(compareSnowflake("100", "100")).toBe(0);
  });
});
