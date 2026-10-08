/**
 * all_visible(ADR-0036)の配線: 検索範囲の決定・定期同期・対象外 clone の削除。
 *
 * - resolveScopeOnce(D1): GIT_CLONE_TOKEN で org のリポを列挙し resolveRepoScope で範囲を決める。
 *   列挙に失敗したら null(呼び出し側が前回の範囲を保つ。削除もしない)。
 * - createPeriodicRepoSync(D5): /ask と同じ SerialQueue 上で、範囲の差し替え + 削除 → 全対象リポの
 *   clone/fetch を**チャンク単位のタスク**で行う。次のチャンクは前のチャンクの完了後に積むため、
 *   その間に来た /ask がチャンクの合間に割り込める(初回の一括 clone で /ask を長く待たせない)。
 *   同期の成功は RepoRegistry.recordFetched で記録し、/ask 側(ask.ts syncForAskPerRepo・段階 1-2)の
 *   TTL 再利用・前回データの許容期間・sync_on_ask 外のリポの引用 SHA にそのまま使われる。
 * - removeOutOfScopeClones(D4): bot が作った(managed_clones に記録がある)dir のうち範囲外の
 *   ものだけを消す。手動指定・KB・記録の無い dir・CLONES_DIR の外・シンボリックリンクは消さない。
 * - findStrayEntries: 範囲外かつ記録の無い CLONES_DIR 直下の項目(旧来の clone・手動配置)を
 *   列挙して warn する(消さない)。agent の cwd は CLONES_DIR なので manifest に無くても読める。
 * - withManagedCloneRecording(D4): RepoSyncer を包み、列挙由来のリポを bot が新規に clone する前に
 *   managed_clones へ記録する。定期同期と /ask(sync_on_ask の列挙分を初回 clone する)の両方が使う。
 *
 * 正常終了(ADR-0035 追記)との関係: 終了処理が始まったら(isStopped / stop())新しいチャンク・リポの
 * 同期を始めず、bot.db(managed_clones)にも触らない。store を触る直前に同期的に確かめるため、
 * 終了処理が DB を閉じた後に書き込むことはない。
 *
 * 副作用(列挙・git・fs・時計)はすべて注入 seam(テストは fake を渡す)。
 */
import {
  lstat as fsLstat,
  readdir as fsReaddir,
  realpath as fsRealpath,
  rm as fsRm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OrgRepo } from "@stratum/gh-client";
import { withCloneToken } from "@stratum/shared";
import type { ManagedCloneStore } from "./db.js";
import type { RepoRegistry } from "./repo-registry.js";
import { type RepoScopeAllVisible, resolveRepoScope, type ScopedRepo } from "./repo-scope.js";
import type { RepoSpec, RepoSyncer, RepoSyncResult } from "./repos.js";

/** 定期同期の既定間隔(env REPO_SYNC_INTERVAL_MS・ADR-0036 D5)。 */
export const DEFAULT_REPO_SYNC_INTERVAL_MS = 600_000;

/**
 * 1 タスクで同期するリポ数。/ask はチャンクの合間に割り込めるため、/ask の追加待ちは
 * 最大 1 チャンク分(定常の fetch で数秒・初回 clone でもリポ数件分)に収まる。
 */
export const REPO_SYNC_CHUNK_SIZE = 5;

/**
 * org リポ列挙の上限(ms)。GitHub API が停滞しても起動(login 前に列挙する)と定期同期
 * (実行中フラグ)を止めない。87 件 = 1 ページで通常 1 秒未満。
 */
export const LIST_ORG_REPOS_TIMEOUT_MS = 30_000;

/** pino 互換の最小ログ口(data + msg、または msg のみ)。 */
export interface RepoSyncLog {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
}

// --- 検索範囲の決定(D1)---

export interface ScopeResolveDeps {
  /** repos.yaml の repos:(url はトークン無し)。 */
  manual: readonly RepoSpec[];
  allVisible: RepoScopeAllVisible | null;
  /** org リポの列挙(GIT_CLONE_TOKEN の gh-client)。トークンが無ければ undefined。 */
  listOrgRepos?: (org: string) => Promise<OrgRepo[]>;
  /** url に実行時注入する clone トークン(ログには出さない)。 */
  cloneToken: string | undefined;
  logger: RepoSyncLog;
  /** 列挙の上限 ms(既定 LIST_ORG_REPOS_TIMEOUT_MS)。 */
  listTimeoutMs?: number;
}

/** promise を ms で打ち切る(超過は reject。元の処理は止められないが結果は捨てる)。 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} が ${ms}ms でタイムアウトしました`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function withToken(repos: readonly ScopedRepo[], token: string | undefined): ScopedRepo[] {
  return repos.map((r) => (r.url !== undefined ? { ...r, url: withCloneToken(r.url, token) } : r));
}

/** 手動指定だけの範囲(all_visible 無し・列挙失敗時の起動フォールバック)。url にトークンを注入済み。 */
export function manualScope(
  manual: readonly RepoSpec[],
  cloneToken: string | undefined,
): ScopedRepo[] {
  return withToken(resolveRepoScope({ manual, allVisible: null, visible: [] }).repos, cloneToken);
}

/**
 * 検索範囲を決める。all_visible が null なら手動指定そのまま(従来挙動・列挙しない)。
 * 列挙できない(トークン無し・API 失敗・タイムアウト)ときは warn して null を返す。
 */
export async function resolveScopeOnce(deps: ScopeResolveDeps): Promise<ScopedRepo[] | null> {
  const { allVisible, logger } = deps;
  if (allVisible === null) return manualScope(deps.manual, deps.cloneToken);
  if (deps.listOrgRepos === undefined) {
    logger.warn(
      { org: allVisible.org },
      "all_visible: GIT_CLONE_TOKEN が無いため org のリポを列挙できません(手動指定のみで続行・ADR-0036)",
    );
    return null;
  }
  let visible: OrgRepo[];
  try {
    visible = await withTimeout(
      deps.listOrgRepos(allVisible.org),
      deps.listTimeoutMs ?? LIST_ORG_REPOS_TIMEOUT_MS,
      "org のリポ列挙",
    );
  } catch (err) {
    logger.warn(
      { org: allVisible.org, err },
      "all_visible: org のリポ列挙に失敗しました(前回の検索範囲を維持・ADR-0036)",
    );
    return null;
  }
  const scope = resolveRepoScope({ manual: deps.manual, allVisible, visible });
  const byReason: Record<string, number> = {};
  for (const e of scope.excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  logger.info(
    {
      org: allVisible.org,
      visible: visible.length,
      repos: scope.repos.length,
      manual: scope.repos.filter((r) => !r.managed).length,
      syncOnAsk: scope.repos.filter((r) => r.syncOnAsk).length,
      excluded: byReason,
      // 手動指定と dir が衝突したものは設定で直せるので名前も出す(リポ名は秘密ではない)。
      conflicts: scope.excluded.filter((e) => e.reason === "conflict").map((e) => e.repo),
    },
    "all_visible: 検索範囲を決定しました(ADR-0036)",
  );
  return withToken(scope.repos, deps.cloneToken);
}

// --- 対象外 clone の削除(D4)---

export interface CloneFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  realpath(p: string): Promise<string>;
  /** rm -rf(シンボリックリンクは辿らない)。 */
  removeDir(p: string): Promise<void>;
  /** ディレクトリ直下の項目名(隠し項目を含む)。 */
  listDir(p: string): Promise<string[]>;
}

export const nodeCloneFs: CloneFs = {
  lstat: (p) => fsLstat(p),
  realpath: (p) => fsRealpath(p),
  removeDir: (p) => fsRm(p, { recursive: true, force: true }),
  listDir: (p) => fsReaddir(p),
};

export interface CloneCleanupDeps {
  store: ManagedCloneStore;
  clonesDir: string;
  /** 決して消さない dir(repos: の手動指定・KB)。 */
  protectedDirs: readonly string[];
  fs: CloneFs;
  logger: RepoSyncLog;
  /**
   * 終了処理が始まったか(ADR-0035 追記の正常終了)。true なら次の項目へ進まず、bot.db にも触らない
   * (未指定 = 常に false)。
   */
  isStopped?: () => boolean;
}

/** CLONES_DIR 直下の 1 セグメントとして安全な dir 名か(repo-scope.ts の isSafeDir と同じ基準 + NUL)。 */
function isSafeDirName(dir: string): boolean {
  return (
    dir.length > 0 &&
    !dir.includes("/") &&
    !dir.includes("\\") &&
    !dir.includes("\0") &&
    !dir.startsWith(".")
  );
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * 範囲外になった managed clone を削除し、消した記録を返す(ADR-0036 D4)。
 * 安全側に倒す条件(いずれかなら消さずに warn・記録は残す):
 * 範囲内・手動指定・KB の dir(大小無視)/ dir 名が 1 セグメントでない / シンボリックリンク /
 * ディレクトリでない / realpath が CLONES_DIR の直下でない。dir が既に無ければ記録だけ消す。
 * 終了処理が始まったら残りは次回に回す(rm 済みで記録が残った dir は、次回「既に無い」として記録だけ消える)。
 */
export async function removeOutOfScopeClones(
  scope: readonly ScopedRepo[],
  deps: CloneCleanupDeps,
): Promise<Array<{ dir: string; repo: string }>> {
  const { store, fs, logger } = deps;
  const stopped = (): boolean => deps.isStopped?.() === true;
  const deleted: Array<{ dir: string; repo: string }> = [];
  if (stopped()) return deleted;
  const keep = new Set(
    [...scope.map((r) => r.dir), ...deps.protectedDirs].map((d) => d.toLowerCase()),
  );
  let realRoot: string | null = null;
  for (const rec of store.listManagedClones()) {
    if (keep.has(rec.dir.toLowerCase())) continue;
    if (stopped()) break;
    const refuse = (reason: string): void =>
      logger.warn(
        { dir: rec.dir, repo: rec.repo, reason },
        "対象外の clone を削除しませんでした(安全確認に失敗・ADR-0036 D4)",
      );
    if (!isSafeDirName(rec.dir)) {
      refuse("unsafe_dir_name");
      continue;
    }
    const abs = join(deps.clonesDir, rec.dir);
    try {
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) {
        refuse("symlink");
        continue;
      }
      if (!st.isDirectory()) {
        refuse("not_directory");
        continue;
      }
      realRoot ??= await fs.realpath(deps.clonesDir);
      if (dirname(await fs.realpath(abs)) !== realRoot) {
        refuse("outside_clones_dir");
        continue;
      }
      if (stopped()) break;
      await fs.removeDir(abs);
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn({ dir: rec.dir, repo: rec.repo, err }, "対象外の clone の削除に失敗しました");
        continue;
      }
      // 既に無い(手動で消された・前回の終了処理で rm 済み等): 記録だけ消す。
    }
    // 終了処理が DB を閉じた後に書き込まない(同期的に確かめてから触る)。
    if (stopped()) break;
    store.removeManagedClone(rec.dir);
    deleted.push({ dir: rec.dir, repo: rec.repo });
    logger.info(
      { dir: rec.dir, repo: rec.repo },
      "対象外になった clone を削除しました(ADR-0036 D4)",
    );
  }
  return deleted;
}

/**
 * CLONES_DIR 直下で「範囲外・手動指定/KB でない・managed の記録も無い」項目を返す(名前昇順)。
 * 消さない(D4: 記録の無い dir には触れない)。agent の cwd は CLONES_DIR のため、ここに残った
 * 除外リポの旧 clone 等は manifest に無くても読める — 人が確認して消すための観測用。
 * CLONES_DIR が無い(初回 clone 前)・終了処理中なら空。
 */
export async function findStrayEntries(
  scope: readonly ScopedRepo[],
  deps: Pick<CloneCleanupDeps, "store" | "clonesDir" | "protectedDirs" | "fs" | "isStopped">,
): Promise<string[]> {
  let names: string[];
  try {
    names = await deps.fs.listDir(deps.clonesDir);
  } catch {
    return [];
  }
  if (deps.isStopped?.() === true) return [];
  const known = new Set(
    [
      ...scope.map((r) => r.dir),
      ...deps.protectedDirs,
      ...deps.store.listManagedClones().map((c) => c.dir),
    ].map((d) => d.toLowerCase()),
  );
  return names.filter((n) => !known.has(n.toLowerCase())).sort();
}

// --- managed clone の記録(D4)---

export interface ManagedRecordingDeps {
  store: ManagedCloneStore;
  clonesDir: string;
  fs: Pick<CloneFs, "lstat">;
  /** ISO 8601(JST)。managed_clones の created_at。 */
  nowIso: () => string;
}

/** ScopedRepo の列挙由来か(syncEach は RepoSpec で受けるため実行時に見る)。 */
function isManagedSpec(spec: RepoSpec): boolean {
  return (spec as Partial<ScopedRepo>).managed === true;
}

/**
 * RepoSyncer を包み、syncEach の前に「列挙由来で、clone 先 dir がまだ無い」リポを managed_clones へ
 * 記録する(ADR-0036 D4)。既存 dir(旧来の clone・手動配置)は記録しない = 削除の対象にしない。
 * clone の前に記録するのは、clone 途中のクラッシュで残った不完全な dir も後で消せるようにするため。
 * 記録に失敗した(bot.db が閉じた等)リポは clone せず status "failed" で返す(記録の無い clone を作らない)。
 * syncEach 以外(sync・HEAD の確認)はそのまま委譲する(手動指定・KB の経路は変えない)。
 */
export function withManagedCloneRecording(
  syncer: RepoSyncer,
  deps: ManagedRecordingDeps,
): RepoSyncer {
  async function prepare(specs: readonly RepoSpec[]): Promise<Map<RepoSpec, unknown>> {
    const refused = new Map<RepoSpec, unknown>();
    const managed = specs.filter(isManagedSpec);
    if (managed.length === 0) return refused;
    let recorded: Set<string>;
    try {
      recorded = new Set(deps.store.listManagedClones().map((c) => c.dir));
    } catch (err) {
      for (const spec of managed) refused.set(spec, err);
      return refused;
    }
    for (const spec of managed) {
      if (recorded.has(spec.dir)) continue;
      try {
        const exists = await deps.fs.lstat(join(deps.clonesDir, spec.dir)).then(
          () => true,
          (err: unknown) => !isNotFound(err),
        );
        if (exists) continue;
        deps.store.addManagedClone({ dir: spec.dir, repo: spec.repo, createdAt: deps.nowIso() });
        recorded.add(spec.dir);
      } catch (err) {
        refused.set(spec, err);
      }
    }
    return refused;
  }
  return {
    ...syncer,
    async syncEach(specs) {
      const refused = await prepare(specs);
      const results = await syncer.syncEach(specs.filter((s) => !refused.has(s)));
      const bySpec = new Map(results.map((r) => [r.spec, r]));
      return specs.map((spec): RepoSyncResult => {
        if (refused.has(spec)) {
          return {
            status: "failed",
            spec,
            error: new Error("managed clone を記録できないため clone しません(ADR-0036 D4)", {
              cause: refused.get(spec),
            }),
          };
        }
        return (
          bySpec.get(spec) ?? {
            status: "failed",
            spec,
            error: new Error("同期結果がありません"),
          }
        );
      });
    },
  };
}

// --- 定期同期(D5)---

export interface PeriodicRepoSyncDeps {
  registry: RepoRegistry;
  /** withManagedCloneRecording で包んだ syncer(新規の列挙由来 clone を記録する)。 */
  syncer: RepoSyncer;
  /** 検索範囲の再決定(resolveScopeOnce を包む)。null = 列挙失敗(前回の範囲を維持・削除しない)。 */
  resolveScope: () => Promise<ScopedRepo[] | null>;
  /** /ask と同じ直列キューへの投入(SerialQueue.enqueue)。 */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  /** 削除・記録の口。isStopped は終了処理の開始(/ask の受付停止)を渡す。 */
  cleanup: CloneCleanupDeps;
  /** 1 タスクで同期するリポ数(既定 REPO_SYNC_CHUNK_SIZE)。 */
  chunkSize?: number;
  /** 壁時計 ms(既定 Date.now)。RepoRegistry.recordFetched の最終成功同期の時刻。 */
  nowMs?: () => number;
  /** 単調クロック ms(所要時間ログ用。既定 performance.now)。 */
  monotonicMs?: () => number;
  logger: RepoSyncLog;
}

export interface PeriodicTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
}

export interface PeriodicRepoSync {
  /**
   * 1 回分: (1) 範囲の差し替え + 対象外 clone の削除 → (2) 全対象リポをチャンク単位で同期。
   * `scope` を渡すとそれを最新の列挙結果として使う(起動時に決めた範囲の再利用)。
   * 前回の実行中に呼ばれたら何もしない(初回 clone が間隔より長くかかっても重ならない)。
   * 停止後(stop・終了処理の開始後)は何もしない。
   */
  runOnce(opts?: { scope?: readonly ScopedRepo[] }): Promise<void>;
  /** intervalMs ごとに runOnce を起動する(2 回目以降の呼び出しは無視)。 */
  start(intervalMs: number, timers?: PeriodicTimers): void;
  /**
   * 停止する(冪等・正常終了用)。タイマを解除し、実行中の回は次のリポ・チャンクの前で打ち切る
   * (実行中の git 1 コマンドは待たない。bot.db には以後触らない)。
   */
  stop(): void;
}

export function createPeriodicRepoSync(deps: PeriodicRepoSyncDeps): PeriodicRepoSync {
  const { registry, syncer, logger } = deps;
  const chunkSize = Math.max(1, deps.chunkSize ?? REPO_SYNC_CHUNK_SIZE);
  const monoNow = deps.monotonicMs ?? ((): number => performance.now());
  const wallNow = deps.nowMs ?? Date.now;
  let running = false;
  let stopped = false;
  let timer: { handle: unknown; clear: (h: unknown) => void } | null = null;
  /** 直近に warn した範囲外項目(同じ一覧を 10 分ごとに繰り返し出さない)。 */
  let lastStray: string | null = null;
  const halted = (): boolean => stopped || deps.cleanup.isStopped?.() === true;
  const cleanup: CloneCleanupDeps = { ...deps.cleanup, isStopped: halted };

  interface ChunkCounts {
    ok: number;
    empty: number;
    failed: number;
  }

  /**
   * 1 チャンクの同期(キュー上で実行)。リポは 1 件ずつ syncEach に渡し、終了処理が始まったら
   * 次のリポへ進まない(managed の記録は syncer 側 = withManagedCloneRecording が行う)。
   */
  async function syncChunk(chunk: readonly ScopedRepo[]): Promise<ChunkCounts> {
    const counts: ChunkCounts = { ok: 0, empty: 0, failed: 0 };
    for (const spec of chunk) {
      if (halted()) break;
      const [r] = await syncer.syncEach([spec]);
      if (r === undefined) continue;
      if (r.status === "synced") {
        // 段階 1-2 の TTL 再利用・前回データの許容期間はこの時刻を見る(fetch の成功として記録)。
        registry.recordFetched(r.synced, wallNow());
        counts.ok += 1;
      } else if (r.status === "empty") {
        // commit の無い空リポ: 失敗ではない(毎回 warn しない)。manifest・allowlist から外れる。
        registry.recordEmpty(r.spec.repo);
        counts.empty += 1;
      } else {
        registry.recordError(r.spec.repo, r.error);
        counts.failed += 1;
        logger.warn(
          { repo: r.spec.repo, err: r.error },
          "定期同期: リポの同期に失敗しました(前回の状態のまま・ADR-0036 D5)",
        );
      }
    }
    return counts;
  }

  async function run(given: readonly ScopedRepo[] | undefined): Promise<void> {
    const startedAt = monoNow();
    const next = given ?? (await deps.resolveScope());
    // (1) 範囲の差し替えと削除は 1 タスクで(検索中の /ask と重ならない)。列挙に失敗した回は
    // 前回の範囲のまま・削除しない(一時的な API 障害で managed clone を一斉に消さない)。
    const deleted = await deps.enqueue(async () => {
      if (next === null || halted()) return [];
      registry.setScope(next);
      const removed = await removeOutOfScopeClones(next, cleanup);
      for (const d of removed) registry.forget(d.repo);
      return removed;
    });
    if (halted()) return;
    // 範囲外かつ記録の無い項目は消さずに warn(起動後の初回と、一覧が変わったときだけ)。
    const stray = await findStrayEntries(registry.scope(), cleanup);
    const strayKey = JSON.stringify(stray);
    if (stray.length > 0 && strayKey !== lastStray) {
      logger.warn(
        { clonesDir: cleanup.clonesDir, entries: stray },
        "CLONES_DIR に検索範囲外かつ bot の記録が無い項目があります。agent から読めるため、不要なら手動で削除してください(bot は消しません・ADR-0036 D4 / ADR-0037)",
      );
    }
    lastStray = strayKey;
    // (2) チャンク単位の同期。次のチャンクは前のチャンクの完了後に積む(/ask が合間に割り込める)。
    const scope = registry.scope();
    const total: ChunkCounts = { ok: 0, empty: 0, failed: 0 };
    for (let i = 0; i < scope.length; i += chunkSize) {
      if (halted()) break;
      const chunk = scope.slice(i, i + chunkSize);
      try {
        const r = await deps.enqueue(() => syncChunk(chunk));
        total.ok += r.ok;
        total.empty += r.empty;
        total.failed += r.failed;
      } catch (err) {
        total.failed += chunk.length;
        logger.warn({ err }, "定期同期: チャンクの処理に失敗しました(次のチャンクへ続行)");
      }
    }
    logger.info(
      {
        scopeRefreshed: next !== null,
        repos: scope.length,
        synced: total.ok,
        empty: total.empty,
        failed: total.failed,
        deleted: deleted.length,
        interrupted: halted(),
        elapsedMs: Math.round(monoNow() - startedAt),
      },
      halted()
        ? "定期同期を終了処理のため途中で打ち切りました(ADR-0036 D5)"
        : "定期同期が完了しました(ADR-0036 D5)",
    );
  }

  const runner: PeriodicRepoSync = {
    async runOnce(opts) {
      if (halted()) return;
      if (running) {
        logger.info({}, "定期同期: 前回の実行中のため今回は skip します");
        return;
      }
      running = true;
      try {
        await run(opts?.scope);
      } catch (err) {
        logger.warn({ err }, "定期同期に失敗しました(次回に再試行)");
      } finally {
        running = false;
      }
    },
    start(intervalMs, timers) {
      if (timer !== null || stopped) return;
      const set = timers?.set ?? ((fn, ms) => setInterval(fn, ms).unref());
      const clear = timers?.clear ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
      timer = { handle: set(() => void runner.runOnce(), intervalMs), clear };
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
