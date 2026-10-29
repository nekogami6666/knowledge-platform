/**
 * 事前起動した Claude Code プロセス(spare)を 1 本だけ預かる入れ物(ADR-0042)。
 *
 * Agent SDK には依存しない(spare の型は総称。SDK の `prewarm()` を呼ぶのは agent.ts)。ここが持つのは寿命の管理だけ:
 * - 預かるのは最大 1 本。準備中(warming)も 1 本と数える。指紋(key)が違う spare は渡さずに閉じる
 * - 待機が `idleMs` を超えたら閉じる(認証・設定の陳腐化を避ける)。作り直しは次の replenish まで遅らせる
 * - 待機中に spare のプロセスが終了したら捨てる
 * - 準備の失敗は呼び出し側へ投げず、警告を 1 回だけ出す。`maxConsecutiveFailures` 回続いたら以後は準備しない
 * - dispose 後は何も預からない(準備中のものも、できあがった時点で閉じる)
 */

/** 預かる spare の最小形(SDK の SpareProcess を包んだもの)。 */
export interface PooledSpare {
  /** プロセスを終了する(claim 前なら破棄・後なら Query を閉じるのと同じ)。何度呼んでもよいこと。 */
  close(): void;
  /** プロセスが終了したら settle する(claim の有無を問わない)。 */
  readonly exited: Promise<void>;
}

/** 警告の出力先(本文・パス・秘密は渡さない)。 */
export type PrewarmWarn = (data: Record<string, unknown>, msg: string) => void;

export interface SparePoolOptions {
  /** 待機の上限 ms(超えたら閉じる)。既定 30 分。 */
  idleMs?: number;
  /** take が準備中の spare を待つ上限 ms(超えたら使わずに従来経路へ)。既定 5000。 */
  takeWaitMs?: number;
  /** 準備がこの回数続けて失敗したら、以後は準備しない。既定 3。 */
  maxConsecutiveFailures?: number;
  onWarn?: PrewarmWarn;
  /** タイマの差し替え(テスト用)。既定 setTimeout / clearTimeout(unref して終了を妨げない)。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 既定の待機上限(30 分)。 */
export const DEFAULT_PREWARM_IDLE_MS = 30 * 60_000;
const DEFAULT_TAKE_WAIT_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export type SparePoolState = "empty" | "warming" | "ready" | "disposed";

export interface SparePool<S extends PooledSpare> {
  /**
   * key が一致する spare を取り出す(準備中なら takeWaitMs まで待つ)。無い・不一致・終了済み・間に合わない
   * ときは undefined(不一致・終了済み・間に合わなかったものは閉じる)。取り出した spare の close は呼び出し側の責任。
   */
  take(key: string): Promise<S | undefined>;
  /** 次の 1 本をバックグラウンドで用意する。同じ key の spare があれば何もしない。違う key なら閉じて作り直す。 */
  replenish(key: string, create: () => Promise<S>): void;
  /** 預かっている spare を閉じ、以後は何も預からない(正常終了用)。 */
  dispose(): Promise<void>;
  /** 観測・テスト用。 */
  state(): SparePoolState;
  /** 種類ごとに 1 回だけ警告する(従来経路へ倒したときの通知)。 */
  warnOnce(kind: string, data: Record<string, unknown>, msg: string): void;
}

interface Slot<S> {
  key: string;
  /** 準備の結果(失敗なら undefined)。 */
  promise: Promise<S | undefined>;
  spare: S | undefined;
  exited: boolean;
  /** 閉じた・捨てた(できあがっても使わない)。 */
  released: boolean;
  /** take が取り出した(準備中なら take が完了を待っている)。 */
  taken: boolean;
  idleTimer: unknown;
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms);
  // 待機タイマで bot / CLI の終了を妨げない。
  (t as { unref?: () => void }).unref?.();
  return t;
};
const defaultClearTimer = (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>);

/** 例外を投げない close(終了済みプロセスの close で投げる実装もありうる)。 */
function safeClose(s: PooledSpare | undefined): void {
  try {
    s?.close();
  } catch {
    // 閉じられなくても後続(従来経路)には影響しない。
  }
}

/** エラーをログ向けの短いラベルにする(SDK のメッセージは `code: 説明` 形式。先頭の code だけを残す)。 */
export function prewarmErrorLabel(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /^([a-z][a-z0-9_]{1,63})(?::|$)/.exec(msg);
  if (m !== null) return m[1] as string;
  return err instanceof Error ? err.name : typeof err;
}

export function createSparePool<S extends PooledSpare>(opts: SparePoolOptions = {}): SparePool<S> {
  const idleMs = opts.idleMs ?? DEFAULT_PREWARM_IDLE_MS;
  const takeWaitMs = opts.takeWaitMs ?? DEFAULT_TAKE_WAIT_MS;
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const clearTimer = opts.clearTimer ?? defaultClearTimer;
  const warned = new Set<string>();
  let slot: Slot<S> | undefined;
  let disposed = false;
  let failures = 0;

  const warnOnce = (kind: string, data: Record<string, unknown>, msg: string): void => {
    if (warned.has(kind)) return;
    warned.add(kind);
    try {
      opts.onWarn?.({ kind, ...data }, msg);
    } catch {
      // 観測側の失敗で検索を止めない。
    }
  };

  /** slot を手放して spare を閉じる(take で渡していないものだけ)。 */
  const drop = (s: Slot<S>): void => {
    if (slot === s) slot = undefined;
    if (s.idleTimer !== undefined) clearTimer(s.idleTimer);
    s.idleTimer = undefined;
    if (!s.released) {
      s.released = true;
      safeClose(s.spare);
    }
  };

  return {
    warnOnce,
    state: () =>
      disposed ? "disposed" : slot === undefined ? "empty" : slot.spare ? "ready" : "warming",

    replenish(key, create) {
      if (disposed || failures >= maxFailures) return;
      if (slot !== undefined) {
        if (slot.key === key && !slot.exited) return;
        drop(slot);
      }
      const s: Slot<S> = {
        key,
        promise: Promise.resolve(undefined),
        spare: undefined,
        exited: false,
        released: false,
        taken: false,
        idleTimer: undefined,
      };
      slot = s;
      s.promise = (async () => {
        try {
          return await create();
        } catch (err) {
          failures += 1;
          warnOnce(
            "prewarm_failed",
            { reason: prewarmErrorLabel(err) },
            "/ask: subprocess の事前起動に失敗したため通常の起動で検索します(ADR-0042)",
          );
          if (failures >= maxFailures) {
            warnOnce(
              "prewarm_disabled",
              { failures },
              "/ask: subprocess の事前起動が続けて失敗したため、このプロセスでは以後事前起動しません(ADR-0042)",
            );
          }
          return undefined;
        }
      })().then((spare) => {
        if (spare === undefined) {
          if (slot === s) slot = undefined;
          return undefined;
        }
        failures = 0;
        s.spare = spare;
        // 準備中に dispose・作り直し・take の待ち切れが起きていたら、できあがった時点で閉じる。
        if (disposed || s.released || (slot !== s && !s.taken)) {
          s.released = true;
          safeClose(spare);
          return undefined;
        }
        void spare.exited.then(
          () => {
            s.exited = true;
            if (slot === s) drop(s);
          },
          () => {
            s.exited = true;
            if (slot === s) drop(s);
          },
        );
        // 待機の上限(take が待っている spare には付けない)。
        if (slot === s) {
          s.idleTimer = setTimer(() => {
            s.idleTimer = undefined;
            if (slot === s) drop(s);
          }, idleMs);
        }
        return spare;
      });
    },

    async take(key) {
      const s = slot;
      if (disposed || s === undefined) return undefined;
      // 以後この slot は預かり物ではない(並行する take・replenish に渡さない)。
      slot = undefined;
      s.taken = true;
      if (s.idleTimer !== undefined) clearTimer(s.idleTimer);
      s.idleTimer = undefined;
      if (s.key !== key) {
        s.released = true;
        safeClose(s.spare);
        // 準備中なら、できあがった時点で閉じる(上の then が released を見る)。
        return undefined;
      }
      let timer: unknown;
      const timedOut = Symbol("timeout");
      const spare = await Promise.race([
        s.promise,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimer(() => resolve(timedOut), takeWaitMs);
        }),
      ]);
      clearTimer(timer);
      if (spare === timedOut || spare === undefined || s.exited || disposed) {
        s.released = true;
        safeClose(s.spare);
        return undefined;
      }
      s.released = true;
      return spare;
    },

    async dispose() {
      disposed = true;
      const s = slot;
      if (s === undefined) return;
      drop(s);
      // 準備中なら完了を待って閉じる(then 側が disposed を見て閉じる)。
      await s.promise.catch(() => undefined);
    },
  };
}
