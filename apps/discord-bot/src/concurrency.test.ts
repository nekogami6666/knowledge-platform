import { describe, expect, it } from "vitest";
import { SerialQueue } from "./concurrency.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("SerialQueue", () => {
  it("タスクを直列(非重複)に順序どおり実行する", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const active = { count: 0, max: 0 };
    const make = (n: number) => async () => {
      active.count++;
      active.max = Math.max(active.max, active.count);
      await delay(5);
      order.push(n);
      active.count--;
    };

    await Promise.all([q.enqueue(make(1)), q.enqueue(make(2)), q.enqueue(make(3))]);

    expect(order).toEqual([1, 2, 3]);
    expect(active.max).toBe(1); // 同時実行は常に 1
  });

  it("各タスクの戻り値を返す", async () => {
    const q = new SerialQueue();
    await expect(q.enqueue(() => Promise.resolve("a"))).resolves.toBe("a");
  });

  it("途中の失敗が後続を壊さない", async () => {
    const q = new SerialQueue();
    const p1 = q.enqueue(() => Promise.reject(new Error("boom")));
    const p2 = q.enqueue(() => Promise.resolve("ok"));
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });
});
