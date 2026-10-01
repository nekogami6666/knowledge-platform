/**
 * 検索範囲と同期状態の保持(ADR-0036 D5)。プロセス内の可変オブジェクト(I/O なし)。
 *
 * - scope: 現在の検索対象(repo-scope.ts の resolveRepoScope の結果)。起動時と定期同期のたびに
 *   差し替わる。/ask は毎回 getter で読む(静的な配列を握らない)。
 * - synced: リポごとの最新の SyncedRepo(absDir・resolvedCommit)。/ask のたびに同期しないリポも、
 *   引用の許可リストはここから作る(無いとコードのリポへの引用がすべて破棄される・D5)。
 * - errors: リポごとの直近の同期失敗(観測用。成功で消える)。
 * - fetchedAt: リポごとの最終成功同期(fetch)の時刻(壁時計 ms)。/ask の TTL 再利用と、同期失敗時に
 *   前回データで検索してよいか(許容期間)の判定に使う(段階 1-2)。HEAD の解決(resolveHead)では更新しない。
 *   プロセス内だけで持つ(再起動後の最初の同期までは「未同期」扱い)。
 * - invalidated: 作業ツリーに書き込みがあったリポ(鮮度確認の KB 書き込み)。次の /ask で TTL 内でも
 *   必ず同期させる。成功同期で解除される。
 *
 * 書き込みは SerialQueue 上のタスク(/ask・定期同期)からのみ行う前提(clone の実体と食い違わない)。
 */
import type { ScopedRepo } from "./repo-scope.js";
import type { SyncedRepo } from "./repos.js";

export interface RepoRegistry {
  /** 現在の検索範囲(手動指定 → 列挙分の順)。 */
  scope(): readonly ScopedRepo[];
  /** 検索範囲を差し替える。範囲外になったリポの同期状態は捨てる。 */
  setScope(repos: readonly ScopedRepo[]): void;
  /** 同期(または HEAD の解決)に成功したリポの状態を記録し、直近の失敗を消す。 */
  recordSynced(s: SyncedRepo): void;
  /**
   * fetch による同期の成功を記録する(recordSynced + 最終成功時刻 + 無効化の解除・段階 1-2)。
   * atMs は壁時計 ms。
   */
  recordFetched(s: SyncedRepo, atMs: number): void;
  /** 最終成功同期(fetch)の時刻(壁時計 ms。未同期なら undefined)。 */
  lastFetchedAt(repo: string): number | undefined;
  /**
   * 作業ツリーに書き込んだ(または書き込む)ことを記録し、次の /ask で TTL 内でも必ず同期させる
   * (鮮度確認の KB 書き込み・段階 1-2)。最終成功時刻は残す(同期失敗時の許容期間の判定に使う)。
   */
  invalidate(repo: string): void;
  /** invalidate 後、まだ同期に成功していないか。 */
  isInvalidated(repo: string): boolean;
  /** 同期失敗を記録する(前回の SyncedRepo は残す)。 */
  recordError(repo: string, error: unknown): void;
  /** 最新の SyncedRepo(未同期なら undefined)。 */
  lastSynced(repo: string): SyncedRepo | undefined;
  /** 直近の同期失敗のメッセージ(無ければ undefined)。 */
  lastError(repo: string): string | undefined;
  /**
   * clone はあるが commit の無い空リポとして記録する(同期状態・失敗は捨てる)。
   * 空リポは manifest・引用の allowlist に載せない。recordSynced で解除される。
   */
  recordEmpty(repo: string): void;
  /** 空リポとして記録されているか。 */
  isEmpty(repo: string): boolean;
  /** 同期状態を捨てる(clone を削除したとき)。 */
  forget(repo: string): void;
}

/**
 * 失敗メッセージ(execFile のエラーはコマンドライン = トークン入り URL を含みうるため userinfo を落とす。
 * ログ側の伏字化(logger.ts)とは別の多重防御・§9.1)。
 */
function errorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.replace(/(https?:\/\/)[^@/\s]+@/g, "$1");
}

export function createRepoRegistry(initial: readonly ScopedRepo[] = []): RepoRegistry {
  let current: readonly ScopedRepo[] = [...initial];
  const synced = new Map<string, SyncedRepo>();
  const errors = new Map<string, string>();
  const empty = new Set<string>();
  const fetchedAt = new Map<string, number>();
  const invalidated = new Set<string>();
  /** リポの同期状態をすべて捨てる。 */
  const dropState = (repo: string): void => {
    synced.delete(repo);
    errors.delete(repo);
    empty.delete(repo);
    fetchedAt.delete(repo);
    invalidated.delete(repo);
  };

  return {
    scope: () => current,
    setScope(repos) {
      current = [...repos];
      const keep = new Set(current.map((r) => r.repo));
      const known = [
        ...synced.keys(),
        ...errors.keys(),
        ...empty,
        ...fetchedAt.keys(),
        ...invalidated,
      ];
      for (const repo of new Set(known)) if (!keep.has(repo)) dropState(repo);
    },
    recordSynced(s) {
      synced.set(s.repo, s);
      errors.delete(s.repo);
      empty.delete(s.repo);
    },
    recordFetched(s, atMs) {
      synced.set(s.repo, s);
      errors.delete(s.repo);
      empty.delete(s.repo);
      fetchedAt.set(s.repo, atMs);
      invalidated.delete(s.repo);
    },
    lastFetchedAt: (repo) => fetchedAt.get(repo),
    invalidate(repo) {
      invalidated.add(repo);
    },
    isInvalidated: (repo) => invalidated.has(repo),
    recordEmpty(repo) {
      dropState(repo);
      empty.add(repo);
    },
    isEmpty: (repo) => empty.has(repo),
    recordError(repo, error) {
      errors.set(repo, errorMessage(error));
    },
    lastSynced: (repo) => synced.get(repo),
    lastError: (repo) => errors.get(repo),
    forget: dropState,
  };
}
