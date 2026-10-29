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

  it("pending は実行中+待機中を数え、成功/失敗どちらでも減る(ADR-0035 D5)", async () => {
    const q = new SerialQueue();
    expect(q.pending).toBe(0);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p1 = q.enqueue(() => gate);
    const p2 = q.enqueue(() => Promise.reject(new Error("boom")));
    expect(q.pending).toBe(2);
    release();
    await p1;
    await expect(p2).rejects.toThrow("boom");
    expect(q.pending).toBe(0);
  });
});

describe("SerialQueue の優先度(ADR-0035 追記 2026-10-08)", () => {
  /** 外から解放できるタスク。 */
  function gated(
    log: string[],
    name: string,
  ): { task: () => Promise<string>; release: () => void } {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    return {
      task: async () => {
        log.push(`start:${name}`);
        await gate;
        log.push(`end:${name}`);
        return name;
      },
      release,
    };
  }

  it("待機中の low は後から来た high に追い越される(同じ優先度は FIFO)", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const first = gated(log, "low0");
    const p0 = q.enqueue(first.task, { priority: "low" });
    const p1 = q.enqueue(async () => void log.push("low1"), { priority: "low" });
    const p2 = q.enqueue(async () => void log.push("low2"), { priority: "low" });
    const p3 = q.enqueue(async () => void log.push("high1"), { priority: "high" });
    const p4 = q.enqueue(async () => void log.push("high2")); // 既定 = high
    await delay(1);
    first.release();
    await Promise.all([p0, p1, p2, p3, p4]);
    expect(log).toEqual(["start:low0", "end:low0", "high1", "high2", "low1", "low2"]);
  });

  it("実行中のタスクは high が来ても中断しない(同時実行は常に 1)", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const running = gated(log, "low");
    const pLow = q.enqueue(running.task, { priority: "low" });
    await delay(1);
    const pHigh = q.enqueue(async () => void log.push("high"), { priority: "high" });
    await delay(5);
    expect(log).toEqual(["start:low"]); // high は low の完了を待つ
    running.release();
    await Promise.all([pLow, pHigh]);
    expect(log).toEqual(["start:low", "end:low", "high"]);
  });

  it("aheadOf('high') は実行中 + 待機中の high だけを数え、pending は全件を数える", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const running = gated(log, "low0");
    const ps = [
      q.enqueue(running.task, { priority: "low" }),
      q.enqueue(async () => "", { priority: "low" }),
      q.enqueue(async () => "", { priority: "high" }),
    ];
    expect(q.pending).toBe(3);
    expect(q.aheadOf("high")).toBe(2); // 実行中の low0 + 待機中の high(待機中の low は追い越す)
    expect(q.aheadOf("low")).toBe(3);
    running.release();
    await Promise.all(ps);
    expect(q.pending).toBe(0);
    expect(q.aheadOf("high")).toBe(0);
  });

  it("空のキューに積んだタスクも enqueue の呼び出しより後に始まる", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const p = q.enqueue(async () => void log.push("task"));
    log.push("after-enqueue");
    await p;
    expect(log).toEqual(["after-enqueue", "task"]);
  });

  it("low の失敗も後続(high・low)を止めない", async () => {
    const q = new SerialQueue();
    const p1 = q.enqueue(() => Promise.reject(new Error("boom")), { priority: "low" });
    const p2 = q.enqueue(() => Promise.resolve("low"), { priority: "low" });
    const p3 = q.enqueue(() => Promise.resolve("high"));
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("low");
    await expect(p3).resolves.toBe("high");
  });
});
