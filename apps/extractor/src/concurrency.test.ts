import { describe, expect, it } from "vitest";
import { mapWithLimit } from "./concurrency.js";

describe("mapWithLimit", () => {
  it("完了順が入力順と違っても入力順で結果を返す", async () => {
    const delays = [30, 0, 15]; // item0 が最後に完了する
    const out = await mapWithLimit([0, 1, 2], 3, async (n) => {
      await new Promise((r) => setTimeout(r, delays[n] ?? 0));
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20]);
  });

  it("同時実行数は limit を超えない", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it("空配列は空を返す", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });

  it("mapper が自分で握れば1件の失敗で全体は落ちない(呼び出し側の skip 契約)", async () => {
    const out = await mapWithLimit([1, 2, 3], 2, async (n) => {
      try {
        if (n === 2) throw new Error("boom");
        return { ok: true, n };
      } catch {
        return { ok: false, n };
      }
    });
    expect(out).toEqual([
      { ok: true, n: 1 },
      { ok: false, n: 2 },
      { ok: true, n: 3 },
    ]);
  });
});
