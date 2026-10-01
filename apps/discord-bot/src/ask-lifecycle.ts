/**
 * /ask の期限・正常終了・強制終了からの後始末(ADR-0035 追記)。
 *
 * - 期限: 受付(deferReply 直後)から「interaction token 15 分 − 余裕 1 分」を全体期限とする。
 *   順番が来た時点でこれを過ぎていたら検索を始めない(discord.ts の handleAsk が判定する)。
 * - 正常終了(SIGTERM/SIGINT): 新規受付を止め、処理中の /ask を最大 graceMs 待ち、超えたら中断する
 *   (AbortSignal を検索まで通す)。中断した /ask は各自が「再起動のため中断しました」に書き換えて
 *   `interrupted` を記録する。本モジュールは受付可否・追跡・待機・中断だけを持ち、Discord には触れない。
 * - 強制終了(SIGKILL/OOM): 処理中の /ask を bot.db の inflight_asks に記録しておき、次回起動時に
 *   15 分以内のものだけ元の ephemeral 応答を webhook で書き換える(recoverInterruptedAsks)。
 *
 * 時計・タイマは注入できる(単体テストは fake で即時に進める)。interaction token はログに出さない。
 */
import type { InflightAsk, InflightAskStore } from "./db.js";

/** Discord interaction token の寿命(15 分)。超えると editReply/followUp は失敗する。 */
export const INTERACTION_TOKEN_MS = 15 * 60_000;
/** 失効判定の余裕。受付からこれを差し引いた時刻を /ask の全体期限とする。 */
export const INTERACTION_DEADLINE_MARGIN_MS = 60_000;

/**
 * 受付(acceptedAt)からの経過で interaction token が失効済み(または配送完了前に失効しうる)と
 * 判定する純関数(ADR-0035 D2)。/ask の全体期限(受付 + 14 分)を過ぎたかの判定を兼ねる。
 * - 順番が来た時点で true → 検索せずに timeout_skipped(ADR-0035 追記 D2')。
 * - 検索後の配送時点で true → interaction を試みず DM で配送(D2 (b))。
 */
export function interactionLikelyExpired(acceptedAtMs: number, nowMs: number): boolean {
  return nowMs - acceptedAtMs > INTERACTION_TOKEN_MS - INTERACTION_DEADLINE_MARGIN_MS;
}

/** interaction token がまだ使える(受付から 15 分未満)か。短い通知を ephemeral に出せるかの判定。 */
export function interactionTokenUsable(acceptedAtMs: number, nowMs: number): boolean {
  return nowMs - acceptedAtMs < INTERACTION_TOKEN_MS;
}

/** 正常終了で処理中の /ask を待つ既定の上限(env SHUTDOWN_GRACE_MS)。 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 60_000;
/**
 * 中断後、各 /ask が中断通知と記録を終えるのを待つ上限。compose の stop_grace_period(90 秒)から
 * 既定の grace(60 秒)を引いた残りに収める。超えた分は inflight_asks に残り、次回起動時に書き換える。
 */
export const DEFAULT_ABORT_SETTLE_MS = 15_000;

/** 受付済み /ask 1 件の追跡券。 */
export interface AskTicket {
  readonly id: string;
  /** 正常終了の猶予を超えたときに abort される。 */
  readonly signal: AbortSignal;
  /** 完了(成功・失敗・中断を問わない)。記録を消して追跡から外す。冪等。 */
  finish(): void;
}

export interface AskLifecycleLog {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
}

export interface AskLifecycleDeps {
  /** 強制終了からの後始末用の記録先。未指定なら記録しない(テスト・開発)。 */
  store?: InflightAskStore;
  newId: () => string;
  /** 処理中の /ask を待つ上限 ms(既定 DEFAULT_SHUTDOWN_GRACE_MS)。 */
  graceMs?: number;
  /** 中断後に各 /ask の後処理を待つ上限 ms(既定 DEFAULT_ABORT_SETTLE_MS)。 */
  abortSettleMs?: number;
  /** タイマ注入(既定 setTimeout / clearTimeout)。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: AskLifecycleLog;
}

export interface ShutdownSummary {
  /** 停止開始時点で処理中だった件数(順番待ちを含む)。 */
  inflightAtStart: number;
  /** 猶予内に全件終わったか。 */
  drained: boolean;
  /** 中断した件数。 */
  aborted: number;
  /** 中断後も後処理が終わらなかった件数(inflight_asks に残り、次回起動時に書き換える)。 */
  unsettled: number;
}

export interface AskLifecycle {
  /** 新規 /ask を受け付けるか(停止開始後は false)。 */
  readonly accepting: boolean;
  /** 処理中(順番待ちを含む)の件数。 */
  readonly inflight: number;
  /** 受付。停止開始後は null(呼び出し側は「再起動中です」を返す)。 */
  begin(input: {
    applicationId: string;
    token: string;
    correlationId: string;
    acceptedAtMs: number;
  }): AskTicket | null;
  /** 受付停止 → 猶予まで待機 → 中断 → 後処理を待機。2 回目以降は同じ Promise を返す。 */
  shutdown(): Promise<ShutdownSummary>;
}

/** 例外から安全な項目だけを取り出す(DiscordAPIError の url には token が入るため err を丸ごと出さない)。 */
export function safeErrorInfo(err: unknown): Record<string, unknown> {
  if (typeof err !== "object" || err === null) return { error: typeof err };
  const e = err as { name?: unknown; code?: unknown; status?: unknown };
  return {
    name: typeof e.name === "string" ? e.name : "unknown",
    ...(typeof e.code === "number" || typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.status === "number" ? { status: e.status } : {}),
  };
}

export function createAskLifecycle(deps: AskLifecycleDeps): AskLifecycle {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const graceMs = deps.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const abortSettleMs = deps.abortSettleMs ?? DEFAULT_ABORT_SETTLE_MS;
  const active = new Map<string, AbortController>();
  const idleWaiters = new Set<() => void>();
  let accepting = true;
  let shutdownPromise: Promise<ShutdownSummary> | null = null;

  const notifyIfIdle = (): void => {
    if (active.size > 0) return;
    for (const w of [...idleWaiters]) w();
  };

  /** 全件終わったら true、ms を超えたら false。 */
  const waitIdle = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (active.size === 0) {
        resolve(true);
        return;
      }
      const done = (idle: boolean): void => {
        idleWaiters.delete(onIdle);
        clearTimer(handle);
        resolve(idle);
      };
      const onIdle = (): void => done(true);
      idleWaiters.add(onIdle);
      const handle = setTimer(() => done(false), ms);
    });

  return {
    get accepting() {
      return accepting;
    },
    get inflight() {
      return active.size;
    },
    begin(input) {
      if (!accepting) return null;
      const id = deps.newId();
      const ctl = new AbortController();
      active.set(id, ctl);
      try {
        deps.store?.addInflightAsk({ id, ...input });
      } catch (err) {
        // 記録できなくても /ask は続ける(失うのは強制終了時の後始末だけ)。token は出さない。
        deps.log?.warn(
          { correlationId: input.correlationId, err: safeErrorInfo(err) },
          "/ask: 処理中の記録に失敗しました(処理は継続・ADR-0035 追記)",
        );
      }
      let finished = false;
      return {
        id,
        signal: ctl.signal,
        finish() {
          if (finished) return;
          finished = true;
          // token は完了時に即削除する(残すのは処理中の間だけ)。
          try {
            deps.store?.removeInflightAsk(id);
          } catch (err) {
            deps.log?.warn(
              { correlationId: input.correlationId, err: safeErrorInfo(err) },
              "/ask: 処理中の記録の削除に失敗しました(次回起動時に消えます)",
            );
          }
          active.delete(id);
          notifyIfIdle();
        },
      };
    },
    shutdown() {
      if (shutdownPromise !== null) return shutdownPromise;
      accepting = false;
      shutdownPromise = (async () => {
        const inflightAtStart = active.size;
        deps.log?.info(
          { inflight: inflightAtStart, graceMs },
          "/ask: 新規受付を停止し、処理中の質問を待ちます",
        );
        if (await waitIdle(graceMs)) {
          return { inflightAtStart, drained: true, aborted: 0, unsettled: 0 };
        }
        const aborted = active.size;
        deps.log?.warn(
          { aborted, graceMs },
          "/ask: 猶予を超えたため処理中の質問を中断します(ADR-0035 追記)",
        );
        for (const ctl of active.values()) ctl.abort();
        await waitIdle(abortSettleMs);
        return { inflightAtStart, drained: false, aborted, unsettled: active.size };
      })();
      return shutdownPromise;
    },
  };
}

export interface GracefulShutdownDeps {
  lifecycle: Pick<AskLifecycle, "shutdown">;
  /** 定期処理のタイマ解除など(任意・失敗は warn)。 */
  stopTimers?: () => void;
  /** Discord クライアントの切断(client.destroy)。 */
  destroyClient: () => Promise<void>;
  /** bot.db を閉じる。 */
  closeStore: () => void;
  exit: (code: number) => void;
  log: AskLifecycleLog;
}

/**
 * SIGTERM/SIGINT のハンドラを作る(冪等: 2 回目以降のシグナルは警告だけ)。
 * 順序: /ask の受付停止・待機・中断 → タイマ解除 → Discord 切断 → DB を閉じる → exit(0)。
 * 途中の失敗は warn にして後段を続ける(終了処理で終了できなくなるのを避ける)。
 */
export function createShutdownHandler(
  deps: GracefulShutdownDeps,
): (signal: string) => Promise<void> {
  let running: Promise<void> | null = null;
  return (signal) => {
    if (running !== null) {
      deps.log.warn({ signal }, "終了処理中のためシグナルを無視します");
      return running;
    }
    running = (async () => {
      deps.log.info({ signal }, "終了シグナルを受信しました(ADR-0035 追記)");
      const step = async (name: string, fn: () => unknown): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          deps.log.warn({ step: name, err: safeErrorInfo(err) }, "終了処理の一部に失敗しました");
        }
      };
      await step("asks", async () => {
        const s = await deps.lifecycle.shutdown();
        deps.log.info({ ...s }, "/ask の終了処理が完了しました");
      });
      await step("timers", () => deps.stopTimers?.());
      await step("discord", () => deps.destroyClient());
      await step("db", () => deps.closeStore());
      deps.exit(0);
    })();
    return running;
  };
}

export interface RecoverDeps {
  /** 起動時(新規受付より前)に読んだ inflight_asks の行。 */
  rows: readonly InflightAsk[];
  store: Pick<InflightAskStore, "removeInflightAsk">;
  nowMs: () => number;
  /** 元の ephemeral 応答を書き換える(PATCH /webhooks/{application_id}/{token}/messages/@original)。 */
  editOriginal: (applicationId: string, token: string, content: string) => Promise<unknown>;
  content: string;
  log: AskLifecycleLog;
}

export interface RecoverSummary {
  edited: number;
  failed: number;
  /** 15 分を過ぎていて書き換えられない(token 失効)ため消しただけの件数。 */
  expired: number;
}

/**
 * 強制終了からの後始末(ADR-0035 追記)。前回プロセスが残した行のうち受付から 15 分未満のものは
 * 進捗表示を content(中断しました)へ書き換え、行はすべて削除する。削除は読んだ行の id 単位で行う
 * (起動直後に受け付けた新しい /ask の行を消さない)。token はログに出さない。
 */
export async function recoverInterruptedAsks(deps: RecoverDeps): Promise<RecoverSummary> {
  const summary: RecoverSummary = { edited: 0, failed: 0, expired: 0 };
  for (const row of deps.rows) {
    try {
      if (!interactionTokenUsable(row.acceptedAtMs, deps.nowMs())) {
        summary.expired += 1;
        continue;
      }
      await deps.editOriginal(row.applicationId, row.token, deps.content);
      summary.edited += 1;
    } catch (err) {
      summary.failed += 1;
      deps.log.warn(
        { correlationId: row.correlationId, err: safeErrorInfo(err) },
        "/ask: 中断した質問の表示を書き換えられませんでした",
      );
    } finally {
      try {
        deps.store.removeInflightAsk(row.id);
      } catch (err) {
        deps.log.warn(
          { correlationId: row.correlationId, err: safeErrorInfo(err) },
          "/ask: 処理中の記録の削除に失敗しました",
        );
      }
    }
  }
  if (deps.rows.length > 0) {
    deps.log.info(
      { ...summary },
      "/ask: 前回の強制終了で中断した質問を後始末しました(ADR-0035 追記)",
    );
  }
  return summary;
}
