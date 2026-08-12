import { describe, expect, it } from "vitest";
import { newId } from "./id-allocator.js";
import { KB_ID_RE } from "./schemas/common.js";

describe("newId(乱数採番・ADR-0026)", () => {
  it("<kind>-<年4桁>-<base36 6文字> 形式を生成し、スキーマを通過する", () => {
    for (const kind of ["kb", "dr", "q"] as const) {
      const id = newId(kind, { now: new Date("2026-08-12T00:00:00+09:00") });
      expect(id).toMatch(new RegExp(`^${kind}-2026-[0-9a-z]{6}$`));
    }
    expect(KB_ID_RE.test(newId("kb"))).toBe(true);
  });

  it("suffix に `-` や大文字を含まない(ファイル名 ID 切り出し規約)", () => {
    for (let i = 0; i < 200; i++) {
      const suffix = newId("kb").split("-")[2];
      expect(suffix).toMatch(/^[0-9a-z]{6}$/);
    }
  });

  it("年は JST 基準(§7.5)— UTC 大晦日 15時以降は翌年になる", () => {
    // 2026-12-31T15:00Z = JST 2027-01-01T00:00
    expect(newId("kb", { now: new Date("2026-12-31T15:00:00Z") })).toMatch(/^kb-2027-/);
    expect(newId("kb", { now: new Date("2026-12-31T14:59:59Z") })).toMatch(/^kb-2026-/);
  });

  it("random seam で決定的にできる(テスト用)", () => {
    const id = newId("dr", { now: new Date("2026-06-11T10:00:00+09:00"), random: () => "abc123" });
    expect(id).toBe("dr-2026-abc123");
  });

  it("連続生成で衝突しない(スモーク)", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("kb")));
    expect(ids.size).toBe(1000);
  });
});
