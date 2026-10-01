/**
 * /ask の進捗ライブ表示(ADR-0035 D5)。defer 後の「考え中」を一定間隔で更新し、
 * 「順番待ち(前に N 件)」「調べています… 経過 N 秒 / 参照 N ファイル(上限 N 秒)」を見せる。
 *
 * 設計:
 * - 文面は純関数 renderProgress。reporter はタイマと in-flight 管理だけを持つ(単体テストは fake timer)。
 * - tick は edit 進行中ならスキップ(Discord への同時 edit を作らない)。
 * - stop() は interval を解除し、進行中の edit を await してから resolve する。最終回答の配送は
 *   stop() の後に行う(古い tick が回答を上書きしない)。
 * - edit の失敗は onError(warn)に流して継続。interaction 失効(isExpired)なら以後の tick を止める。
 */

import type { AskProgressEvent } from "./ask.js";

export type ProgressPhase = "queued" | "sync" | "search";

export interface ProgressState {
  phase: ProgressPhase;
  /** 受付からの経過 ms。 */
  elapsedMs: number;
  /** これまでのツール呼び出し回数(Read/Grep/Glob)。 */
  toolCalls: number;
  /** 検索タイムアウト(ms)。文面の「上限 N 秒」に使う。 */
  timeoutMs: number;
  /** 直列キューで自分より前に並ぶ件数。 */
  queueAhead: number;
}

/** 進捗文面(純関数)。 */
export function renderProgress(s: ProgressState): string {
  const sec = Math.max(0, Math.round(s.elapsedMs / 1000));
  const limit = Math.round(s.timeoutMs / 1000);
  if (s.phase === "queued") {
    return `順番待ちです(前に ${s.queueAhead} 件)… 経過 ${sec} 秒`;
  }
  if (s.phase === "sync") {
    return `ナレッジの最新化中… 経過 ${sec} 秒`;
  }
  return `調べています… 経過 ${sec} 秒 / 参照 ${s.toolCalls} ファイル(上限 ${limit} 秒)`;
}

export interface ProgressReporterDeps {
  /** 進捗の書き込み先(interaction.editReply のアダプタ)。 */
  edit: (content: string) => Promise<unknown>;
  timeoutMs: number;
  /** 更新間隔 ms(既定 5000。Discord の edit レート制限に十分な余裕)。 */
  intervalMs?: number;
  /** 壁時計(注入・既定 Date.now)。 */
  now?: () => number;
  /** edit 失敗の観測(warn)。 */
  onError: (err: unknown) => void;
  /** 失効エラー判定。true なら以後の tick を止める(既定: 止めない)。 */
  isExpired?: (err: unknown) => boolean;
  /**
   * 中断(bot の正常終了・ADR-0035 追記)。abort されたら以後の tick を止めてタイマを解除する
   * (中断通知を古い tick が上書きしない・終了時にタイマを残さない)。進行中の edit は stop() で待つ。
   */
  signal?: AbortSignal;
  /** タイマ注入(テスト用・既定 setInterval / clearInterval)。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ProgressReporter {
  onEvent(ev: AskProgressEvent): void;
  setQueueAhead(n: number): void;
  /** 更新を止め、進行中の edit があれば待つ。以後の onEvent は無視する。 */
  stop(): Promise<void>;
}

export const DEFAULT_PROGRESS_INTERVAL_MS = 5000;

export function startProgressReporter(deps: ProgressReporterDeps): ProgressReporter {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const startedAt = now();
  const state: ProgressState = {
    phase: "queued",
    elapsedMs: 0,
    toolCalls: 0,
    timeoutMs: deps.timeoutMs,
    queueAhead: 0,
  };
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  const tick = (): void => {
    if (stopped || inFlight !== null) return;
    state.elapsedMs = now() - startedAt;
    const p = deps
      .edit(renderProgress(state))
      .catch((err: unknown) => {
        deps.onError(err);
        if (deps.isExpired?.(err) ?? false) halt();
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = p;
  };
  const handle = setTimer(tick, deps.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  const halt = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimer(handle);
  };
  if (deps.signal?.aborted === true) halt();
  else deps.signal?.addEventListener("abort", halt, { once: true });

  return {
    onEvent(ev) {
      if (stopped) return;
      if (ev.kind === "sync") state.phase = "sync";
      else if (ev.kind === "search") state.phase = "search";
      else state.toolCalls += 1;
    },
    setQueueAhead(n) {
      state.queueAhead = n;
    },
    async stop() {
      halt();
      deps.signal?.removeEventListener("abort", halt);
      if (inFlight !== null) await inFlight;
    },
  };
}
