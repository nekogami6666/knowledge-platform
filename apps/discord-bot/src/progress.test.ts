import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  type ProgressReporterDeps,
  renderProgress,
  startProgressReporter,
} from "./progress.js";

describe("renderProgress(ADR-0035 D5 文面)", () => {
  const base = { elapsedMs: 45_400, toolCalls: 6, timeoutMs: 600_000, queueAhead: 0 };
  it("queued は前の件数と経過秒", () => {
    expect(renderProgress({ ...base, phase: "queued", queueAhead: 2 })).toBe(
      "順番待ちです(前に 2 件)… 経過 45 秒",
    );
  });
  it("sync は最新化中", () => {
    expect(renderProgress({ ...base, phase: "sync" })).toBe("ナレッジの最新化中… 経過 45 秒");
  });
  it("search は参照ファイル数と上限秒(実効タイムアウトに追随)", () => {
    expect(renderProgress({ ...base, phase: "search" })).toBe(
      "調べています… 経過 45 秒 / 参照 6 ファイル(上限 600 秒)",
    );
    expect(renderProgress({ ...base, phase: "search", timeoutMs: 120_000 })).toContain(
      "上限 120 秒",
    );
  });
  it("負の経過は 0 に丸める", () => {
    expect(renderProgress({ ...base, phase: "sync", elapsedMs: -10 })).toContain("経過 0 秒");
  });
});

/** 手動で tick を進める fake timer。 */
function fakeTimer(): {
  fire: () => void;
  cleared: () => boolean;
  deps: Partial<ProgressReporterDeps>;
} {
  let fn: (() => void) | null = null;
  let cleared = false;
  return {
    fire: () => fn?.(),
    cleared: () => cleared,
    deps: {
      setTimer: (f) => {
        fn = f;
        return "h";
      },
      clearTimer: () => {
        cleared = true;
      },
    },
  };
}

describe("startProgressReporter", () => {
  it("既定間隔は 5 秒(Discord の edit レート制限に余裕)", () => {
    expect(DEFAULT_PROGRESS_INTERVAL_MS).toBe(5000);
  });

  it("tick ごとに現在のフェーズを edit し、イベントで phase / toolCalls が進む", async () => {
    const edits: string[] = [];
    const t = fakeTimer();
    let now = 1000;
    const r = startProgressReporter({
      edit: async (c) => {
        edits.push(c);
      },
      timeoutMs: 600_000,
      now: () => now,
      onError: () => {},
      ...t.deps,
    });
    const flush = () => new Promise((res) => setTimeout(res, 0)); // edit の then/finally 連鎖を流す
    r.setQueueAhead(1);
    now += 5000;
    t.fire();
    await flush();
    r.onEvent({ kind: "sync" });
    now += 5000;
    t.fire();
    await flush();
    r.onEvent({ kind: "search" });
    r.onEvent({ kind: "tool_use", tool: "Grep", turn: 1 });
    r.onEvent({ kind: "tool_use", tool: "Read", turn: 2 });
    now += 5000;
    t.fire();
    await r.stop();
    expect(edits).toEqual([
      "順番待ちです(前に 1 件)… 経過 5 秒",
      "ナレッジの最新化中… 経過 10 秒",
      "調べています… 経過 15 秒 / 参照 2 ファイル(上限 600 秒)",
    ]);
    expect(t.cleared()).toBe(true);
  });

  it("edit 進行中の tick はスキップし、stop() は進行中の edit を待ってから resolve する", async () => {
    let release: () => void = () => {};
    let finished = false;
    const t = fakeTimer();
    let calls = 0;
    const r = startProgressReporter({
      edit: () => {
        calls += 1;
        return new Promise<void>((res) => {
          release = () => {
            finished = true;
            res();
          };
        });
      },
      timeoutMs: 1,
      onError: () => {},
      ...t.deps,
    });
    t.fire();
    t.fire(); // in-flight 中 → スキップ
    expect(calls).toBe(1);
    let stopped = false;
    const stopping = r.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false); // まだ edit が終わっていない
    release();
    await stopping;
    expect(finished).toBe(true);
    // stop 後の tick / event は無視される。
    t.fire();
    r.onEvent({ kind: "search" });
    expect(calls).toBe(1);
  });

  it("edit 失敗は onError に流して継続、isExpired なら以後止める", async () => {
    const errors: unknown[] = [];
    const t = fakeTimer();
    let calls = 0;
    const r = startProgressReporter({
      edit: async () => {
        calls += 1;
        throw new Error(calls === 1 ? "transient" : "expired");
      },
      timeoutMs: 1,
      onError: (e) => errors.push(e),
      isExpired: (e) => e instanceof Error && e.message === "expired",
      ...t.deps,
    });
    t.fire();
    await new Promise((res) => setTimeout(res, 0));
    t.fire();
    await new Promise((res) => setTimeout(res, 0));
    expect(errors).toHaveLength(2);
    expect(t.cleared()).toBe(true); // expired で自動停止
    t.fire();
    await new Promise((res) => setTimeout(res, 0));
    expect(calls).toBe(2);
    await r.stop();
  });
});
