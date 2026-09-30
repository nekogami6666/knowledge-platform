/**
 * 検索範囲と同期状態の保持(ADR-0036 D5)。プロセス内の可変オブジェクト(I/O なし)。
 *
 * - scope: 現在の検索対象(repo-scope.ts の resolveRepoScope の結果)。起動時と定期同期のたびに
 *   差し替わる。/ask は毎回 getter で読む(静的な配列を握らない)。
 * - synced: リポごとの最新の SyncedRepo(absDir・resolvedCommit)。/ask のたびに同期しないリポも、
 *   引用の許可リストはここから作る(無いとコードのリポへの引用がすべて破棄される・D5)。
 * - errors: リポごとの直近の同期失敗(観測用。成功で消える)。
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

  return {
    scope: () => current,
    setScope(repos) {
      current = [...repos];
      const keep = new Set(current.map((r) => r.repo));
      for (const repo of [...synced.keys()]) if (!keep.has(repo)) synced.delete(repo);
      for (const repo of [...errors.keys()]) if (!keep.has(repo)) errors.delete(repo);
      for (const repo of [...empty]) if (!keep.has(repo)) empty.delete(repo);
    },
    recordSynced(s) {
      synced.set(s.repo, s);
      errors.delete(s.repo);
      empty.delete(s.repo);
    },
    recordEmpty(repo) {
      synced.delete(repo);
      errors.delete(repo);
      empty.add(repo);
    },
    isEmpty: (repo) => empty.has(repo),
    recordError(repo, error) {
      errors.set(repo, errorMessage(error));
    },
    lastSynced: (repo) => synced.get(repo),
    lastError: (repo) => errors.get(repo),
    forget(repo) {
      synced.delete(repo);
      errors.delete(repo);
      empty.delete(repo);
    },
  };
}
