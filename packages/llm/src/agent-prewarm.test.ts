import { describe, expect, it, vi } from "vitest";
import { createSparePool, type PooledSpare, prewarmErrorLabel } from "./agent-prewarm.js";

/** 終了を外から起こせる疑似 spare。 */
function fakeSpare(): PooledSpare & { closed: number; exit: () => void } {
  let exit = (): void => {};
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const s = {
    closed: 0,
    exited,
    close: () => {
      s.closed += 1;
    },
    exit: () => exit(),
  };
  return s;
}

/** 手動で進めるタイマ(setTimer / clearTimer の差し替え)。 */
function manualTimers() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    /** ms 以下のタイマを発火する。 */
    fire: (ms: number) => {
      for (const [id, t] of [...timers]) {
        if (t.ms <= ms) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createSparePool(ADR-0042)", () => {
  it("replenish で用意した spare を同じ key の take で渡し、渡した後は空になる", async () => {
    const pool = createSparePool();
    const s = fakeSpare();
    pool.replenish("k", async () => s);
    expect(pool.state()).toBe("warming");
    await flush();
    expect(pool.state()).toBe("ready");
    await expect(pool.take("k")).resolves.toBe(s);
    expect(pool.state()).toBe("empty");
    // 渡したものは閉じない(閉じるのは使った側)。
    expect(s.closed).toBe(0);
    await expect(pool.take("k")).resolves.toBeUndefined();
  });

  it("準備中の spare は take が完了を待って渡す", async () => {
    const pool = createSparePool();
    const s = fakeSpare();
    let resolve: (v: typeof s) => void = () => {};
    pool.replenish("k", () => new Promise((r) => (resolve = r)));
    const taken = pool.take("k");
    resolve(s);
    await expect(taken).resolves.toBe(s);
  });

  it("準備が takeWaitMs に間に合わなければ使わず、できあがった時点で閉じる", async () => {
    const t = manualTimers();
    const pool = createSparePool({ takeWaitMs: 5_000, ...t });
    const s = fakeSpare();
    let resolve: (v: typeof s) => void = () => {};
    pool.replenish("k", () => new Promise((r) => (resolve = r)));
    const taken = pool.take("k");
    t.fire(5_000);
    await expect(taken).resolves.toBeUndefined();
    resolve(s);
    await flush();
    expect(s.closed).toBe(1);
  });

  it("key が違えば渡さずに閉じる(構成の変更・env の差し替え)", async () => {
    const pool = createSparePool();
    const s = fakeSpare();
    pool.replenish("old", async () => s);
    await flush();
    await expect(pool.take("new")).resolves.toBeUndefined();
    expect(s.closed).toBe(1);
  });

  it("同じ key で replenish し直しても作り直さない。違う key なら前のを閉じて作り直す", async () => {
    const pool = createSparePool();
    const a = fakeSpare();
    const b = fakeSpare();
    const create = vi.fn(async () => a);
    pool.replenish("k", create);
    pool.replenish("k", create);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    pool.replenish("k2", async () => b);
    expect(a.closed).toBe(1);
    await flush();
    await expect(pool.take("k2")).resolves.toBe(b);
  });

  it("待機が idleMs を超えたら閉じ、作り直しは次の replenish まで遅らせる", async () => {
    const t = manualTimers();
    const pool = createSparePool({ idleMs: 30 * 60_000, ...t });
    const s = fakeSpare();
    pool.replenish("k", async () => s);
    await flush();
    expect(pool.state()).toBe("ready");
    t.fire(30 * 60_000);
    expect(s.closed).toBe(1);
    expect(pool.state()).toBe("empty");
    await expect(pool.take("k")).resolves.toBeUndefined();
  });

  it("take で渡した spare の待機タイマは止める(使用中に閉じない)", async () => {
    const t = manualTimers();
    const pool = createSparePool({ idleMs: 1_000, ...t });
    const s = fakeSpare();
    pool.replenish("k", async () => s);
    await flush();
    await pool.take("k");
    t.fire(1_000);
    expect(s.closed).toBe(0);
  });

  it("待機中に spare のプロセスが終了したら捨てる", async () => {
    const pool = createSparePool();
    const s = fakeSpare();
    pool.replenish("k", async () => s);
    await flush();
    s.exit();
    await flush();
    expect(pool.state()).toBe("empty");
    await expect(pool.take("k")).resolves.toBeUndefined();
  });

  it("dispose は待機中の spare を閉じ、以後は replenish しない", async () => {
    const pool = createSparePool();
    const s = fakeSpare();
    pool.replenish("k", async () => s);
    await flush();
    await pool.dispose();
    expect(s.closed).toBe(1);
    expect(pool.state()).toBe("disposed");
    const create = vi.fn(async () => fakeSpare());
    pool.replenish("k", create);
    expect(create).not.toHaveBeenCalled();
    await expect(pool.take("k")).resolves.toBeUndefined();
  });

  it("dispose は準備中の spare をできあがった時点で閉じる(待ってから返る)", async () => {
    const pool = createSparePool();
    const s = fakeSpare();
    let resolve: (v: typeof s) => void = () => {};
    pool.replenish("k", () => new Promise((r) => (resolve = r)));
    const disposed = pool.dispose();
    resolve(s);
    await disposed;
    expect(s.closed).toBe(1);
  });

  it("準備の失敗は投げずに警告を 1 回だけ出し、続けて失敗したら以後は準備しない", async () => {
    const warns: Array<{ data: Record<string, unknown>; msg: string }> = [];
    const pool = createSparePool({
      maxConsecutiveFailures: 2,
      onWarn: (data, msg) => warns.push({ data, msg }),
    });
    const create = vi.fn(async (): Promise<PooledSpare> => {
      throw new Error("spare_exited: the spare process exited before it was claimed");
    });
    pool.replenish("k", create);
    await flush();
    expect(pool.state()).toBe("empty");
    pool.replenish("k", create);
    await flush();
    pool.replenish("k", create);
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(warns.map((w) => w.data.kind)).toEqual(["prewarm_failed", "prewarm_disabled"]);
    // 理由は先頭のコードだけ(本文・パスを出さない)。
    expect(warns[0]?.data.reason).toBe("spare_exited");
  });

  it("prewarmErrorLabel: SDK の `code: 説明` は code だけ、それ以外はエラー名", () => {
    expect(prewarmErrorLabel(new Error("cwd_not_found: the claim cwd does not exist"))).toBe(
      "cwd_not_found",
    );
    expect(prewarmErrorLabel(new Error("Some /secret/path failed"))).toBe("Error");
    expect(prewarmErrorLabel(new TypeError("x y"))).toBe("TypeError");
    expect(prewarmErrorLabel(42)).toBe("number");
  });
});
