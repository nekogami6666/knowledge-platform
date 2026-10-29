/**
 * /ask の先回り同期(ADR-0035 追記 2026-10-08「同期をクリティカルパスから外す」)。
 *
 * /ask は sync_on_ask のリポを TTL(ASK_SYNC_TTL_MS・既定 60 秒)内なら fetch せずに再利用する(段階 1-2)。
 * 本モジュールは一定間隔(ASK_BACKGROUND_SYNC_MS・既定 45 秒)ごとに、**キューが空のときだけ** sync_on_ask の
 * リポを low 優先度のタスクで同期して RepoRegistry に記録し、次の /ask が TTL 内の再利用に当たるようにする
 * (/ask が同期を待たない)。
 *
 * - 書き込み(fetch / reset / clean)は必ず /ask と同じ SerialQueue 上で行う(検索中の clone を書き換えない)。
 *   low 優先度なので、待機中に /ask が来ればそちらが先に実行される。実行中の同期は中断しない(数秒)。
 * - キューに何かある(/ask の実行・待機中、定期同期のチャンク等)ときは積まない(/ask を待たせない・
 *   その /ask 自身が必要なら同期する)。前回の分が終わっていなければ積まない(重ねない)。
 * - 次の周期までに TTL を過ぎないリポ(直前の /ask・定期同期が同期した)は省く。
 *   無効化(鮮度確認の書き込み)されたリポ・未同期のリポは常に対象。空リポは対象外(/ask 側が見る)。
 * - 失敗は RepoRegistry.recordError に記録し、リポごとに失敗に転じたときだけ warn する(45 秒ごとに
 *   同じ warn を繰り返さない)。/ask 側の前回データ利用・エラー判定は従来どおり。
 * - 正常終了(ADR-0035 追記)では stop() でタイマを止め、以後は積まない・積まれた分も何もしない。
 *
 * 時計・タイマ・キュー・syncer はすべて注入 seam(テストは fake を渡す)。
 */
import type { RepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";
import type { PeriodicTimers, RepoSyncLog } from "./repo-sync.js";
import type { RepoSyncer } from "./repos.js";

/** 先回り同期の既定間隔(env ASK_BACKGROUND_SYNC_MS・0 で無効)。既定 TTL(60 秒)より短くする。 */
export const DEFAULT_ASK_BACKGROUND_SYNC_MS = 45_000;

export interface AskBackgroundSyncDeps {
  registry: RepoRegistry;
  syncer: RepoSyncer;
  /** キューが空(実行中も待機中も無い)か(SerialQueue.pending === 0)。 */
  isQueueIdle: () => boolean;
  /** /ask と同じ直列キューへ low 優先度で積む。 */
  enqueueLow: <T>(task: () => Promise<T>) => Promise<T>;
  /** /ask の TTL 再利用の ms(次の周期までに TTL を過ぎないリポは省く)。 */
  ttlMs: number;
  /** 終了処理が始まったか(/ask の受付停止。未指定 = 常に false)。 */
  isStopped?: () => boolean;
  /** 壁時計 ms(既定 Date.now)。RepoRegistry.recordFetched の時刻。 */
  nowMs?: () => number;
  logger: RepoSyncLog;
}

/** tick の結果(テスト・観測用)。 */
export type AskBackgroundTickResult =
  | { kind: "stopped" }
  | { kind: "busy" }
  | { kind: "queue_busy" }
  | { kind: "ran"; synced: number; failed: number };

export interface AskBackgroundSync {
  /**
   * 1 回分。キューが空で前回の分も終わっていれば low 優先度のタスクを積み、その完了まで待つ。
   * intervalMs は「次の周期までに TTL を過ぎるか」の判定に使う(start の間隔と同じ値)。
   */
  tick(intervalMs: number): Promise<AskBackgroundTickResult>;
  /** intervalMs ごとに tick する(0 以下・2 回目以降・停止後は何もしない)。 */
  start(intervalMs: number, timers?: PeriodicTimers): void;
  /** 停止する(冪等・正常終了用)。タイマを解除し、以後は積まない・積まれた分も同期しない。 */
  stop(): void;
}

export function createAskBackgroundSync(deps: AskBackgroundSyncDeps): AskBackgroundSync {
  const { registry, syncer, logger } = deps;
  const nowMs = deps.nowMs ?? Date.now;
  let running = false;
  let stopped = false;
  let timer: { handle: unknown; clear: (h: unknown) => void } | null = null;
  /** 直近の先回り同期で失敗していたリポ(warn を失敗に転じたときだけ出す)。 */
  const failing = new Set<string>();
  const halted = (): boolean => stopped || deps.isStopped?.() === true;

  /** 次の周期までに TTL を過ぎる(または未同期・無効化済み)の sync_on_ask のリポ。 */
  function dueRepos(intervalMs: number): ScopedRepo[] {
    const now = nowMs();
    return registry.scope().filter((r) => {
      if (!r.syncOnAsk || registry.isEmpty(r.repo)) return false;
      const at = registry.lastFetchedAt(r.repo);
      if (at === undefined || registry.isInvalidated(r.repo)) return true;
      return now - at + intervalMs >= deps.ttlMs;
    });
  }

  /** キュー上で実行する本体。 */
  async function job(intervalMs: number): Promise<{ synced: number; failed: number }> {
    const counts = { synced: 0, failed: 0 };
    if (halted()) return counts;
    const due = dueRepos(intervalMs);
    if (due.length === 0) return counts;
    const results = await syncer.syncEach(due);
    const at = nowMs();
    for (const r of results) {
      if (r.status === "synced") {
        registry.recordFetched(r.synced, at);
        counts.synced += 1;
        if (failing.delete(r.spec.repo)) {
          logger.info({ repo: r.spec.repo }, "/ask の先回り同期: リポの同期が回復しました");
        }
      } else if (r.status === "empty") {
        registry.recordEmpty(r.spec.repo);
        failing.delete(r.spec.repo);
      } else {
        registry.recordError(r.spec.repo, r.error);
        counts.failed += 1;
        if (!failing.has(r.spec.repo)) {
          failing.add(r.spec.repo);
          logger.warn(
            { repo: r.spec.repo, err: r.error },
            "/ask の先回り同期: リポの同期に失敗しました(次の /ask が同期し直す・ADR-0035 追記)",
          );
        }
      }
    }
    return counts;
  }

  const runner: AskBackgroundSync = {
    async tick(intervalMs) {
      if (halted()) return { kind: "stopped" };
      if (running) return { kind: "busy" };
      if (!deps.isQueueIdle()) return { kind: "queue_busy" };
      running = true;
      try {
        const r = await deps.enqueueLow(() => job(intervalMs));
        return { kind: "ran", ...r };
      } catch (err) {
        logger.warn({ err }, "/ask の先回り同期に失敗しました(次の周期で再試行)");
        return { kind: "ran", synced: 0, failed: 0 };
      } finally {
        running = false;
      }
    },
    start(intervalMs, timers) {
      if (intervalMs <= 0 || timer !== null || stopped) return;
      const set = timers?.set ?? ((fn, ms) => setInterval(fn, ms).unref());
      const clear = timers?.clear ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
      timer = { handle: set(() => void runner.tick(intervalMs), intervalMs), clear };
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        timer.clear(timer.handle);
        timer = null;
      }
    },
  };
  return runner;
}
