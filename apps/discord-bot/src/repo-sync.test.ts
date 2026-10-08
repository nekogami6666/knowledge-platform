import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrgRepo } from "@stratum/gh-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncForAskPerRepo } from "./ask.js";
import { SerialQueue } from "./concurrency.js";
import { createMemoryStore } from "./db.js";
import { createRepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";
import {
  type CloneCleanupDeps,
  type CloneFs,
  createPeriodicRepoSync,
  findStrayEntries,
  manualScope,
  nodeCloneFs,
  removeOutOfScopeClones,
  resolveScopeOnce,
  withManagedCloneRecording,
} from "./repo-sync.js";
import type { RepoSpec, RepoSyncer, RepoSyncResult } from "./repos.js";

type LogCall = [Record<string, unknown>, string];

function logs(): {
  logger: {
    info: (d: Record<string, unknown>, m: string) => void;
    warn: (d: Record<string, unknown>, m: string) => void;
  };
  infos: LogCall[];
  warns: LogCall[];
} {
  const infos: LogCall[] = [];
  const warns: LogCall[] = [];
  return {
    infos,
    warns,
    logger: {
      info: (d, m) => infos.push([d, m]),
      warn: (d, m) => warns.push([d, m]),
    },
  };
}

const orgRepo = (name: string, over: Partial<OrgRepo> = {}): OrgRepo => ({
  name,
  fullName: `org/${name}`,
  archived: false,
  fork: false,
  description: null,
  ...over,
});
const scoped = (name: string, over: Partial<ScopedRepo> = {}): ScopedRepo => ({
  repo: `org/${name}`,
  dir: name,
  url: `https://github.com/org/${name}.git`,
  syncOnAsk: false,
  managed: true,
  ...over,
});

const manual: RepoSpec[] = [
  {
    repo: "org/knowledge-base",
    dir: "knowledge-base",
    url: "https://github.com/org/knowledge-base.git",
  },
];

describe("resolveScopeOnce(ADR-0036 D1)", () => {
  it("all_visible が null なら手動指定そのまま(url にトークン注入・列挙しない)", async () => {
    const list = vi.fn();
    const { logger } = logs();
    const scope = await resolveScopeOnce({
      manual,
      allVisible: null,
      listOrgRepos: list,
      cloneToken: "TKN",
      logger,
    });
    expect(list).not.toHaveBeenCalled();
    expect(scope).toEqual([
      {
        repo: "org/knowledge-base",
        dir: "knowledge-base",
        url: "https://x-access-token:TKN@github.com/org/knowledge-base.git",
        syncOnAsk: true,
        managed: false,
      },
    ]);
  });

  it("列挙分をトークン付き url で返し、件数と除外理由の内訳をログに出す(トークンは出さない)", async () => {
    const { logger, infos } = logs();
    const scope = await resolveScopeOnce({
      manual,
      allVisible: { org: "org", exclude: ["board-minutes"], sync_on_ask: ["*-minutes"] },
      listOrgRepos: async () => [
        orgRepo("app"),
        orgRepo("biz-minutes"),
        orgRepo("board-minutes"),
        orgRepo("old", { archived: true }),
      ],
      cloneToken: "TKN",
      logger,
    });
    expect(scope?.map((r) => [r.repo, r.syncOnAsk, r.managed])).toEqual([
      ["org/knowledge-base", true, false],
      ["org/app", false, true],
      ["org/biz-minutes", true, true],
    ]);
    expect(scope?.find((r) => r.repo === "org/app")?.url).toBe(
      "https://x-access-token:TKN@github.com/org/app.git",
    );
    expect(infos[0]?.[0]).toMatchObject({
      visible: 4,
      repos: 3,
      excluded: { exclude: 1, archived: 1 },
    });
    expect(JSON.stringify(infos)).not.toContain("TKN");
  });

  it("列挙に失敗・トークン無しなら warn して null(呼び出し側が前回の範囲を保つ)", async () => {
    const allVisible = { org: "org", exclude: [], sync_on_ask: [] };
    const a = logs();
    expect(
      await resolveScopeOnce({
        manual,
        allVisible,
        listOrgRepos: async () => {
          throw new Error("API down");
        },
        cloneToken: "TKN",
        logger: a.logger,
      }),
    ).toBeNull();
    expect(a.warns).toHaveLength(1);
    const b = logs();
    expect(
      await resolveScopeOnce({ manual, allVisible, cloneToken: undefined, logger: b.logger }),
    ).toBeNull();
    expect(b.warns).toHaveLength(1);
  });

  it("列挙が停滞したら打ち切って null(起動・定期同期を止めない)", async () => {
    vi.useFakeTimers();
    try {
      const { logger, warns } = logs();
      const p = resolveScopeOnce({
        manual,
        allVisible: { org: "org", exclude: [], sync_on_ask: [] },
        listOrgRepos: () => new Promise<OrgRepo[]>(() => {}),
        cloneToken: "TKN",
        logger,
        listTimeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBeNull();
      expect(warns).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manualScope", () => {
  it("トークン無しなら url をそのまま返す(手動指定は syncOnAsk・managed でない)", () => {
    expect(manualScope(manual, undefined)).toEqual([
      { ...manual[0], syncOnAsk: true, managed: false },
    ]);
  });
});

describe("removeOutOfScopeClones / findStrayEntries(ADR-0036 D4: 削除の安全条件・実 fs)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const exists = (p: string): Promise<boolean> =>
    stat(p).then(
      () => true,
      () => false,
    );
  async function setup(): Promise<{
    root: string;
    clones: string;
    store: ReturnType<typeof createMemoryStore>;
    deps: CloneCleanupDeps;
  }> {
    const root = await mkdtemp(join(tmpdir(), "bot-cleanup-"));
    roots.push(root);
    const clones = join(root, "clones");
    await mkdir(clones);
    const { logger } = logs();
    const store = createMemoryStore();
    const deps: CloneCleanupDeps = {
      store,
      clonesDir: clones,
      protectedDirs: ["knowledge-base", "dev-minutes"],
      fs: nodeCloneFs,
      logger,
    };
    return { root, clones, store, deps };
  }
  const rec = (dir: string) => ({ dir, repo: `org/${dir}`, createdAt: "t" });

  it("範囲外になった managed dir だけを消し、記録も消す(記録の無い dir には触れない)", async () => {
    const { clones, store, deps } = await setup();
    for (const d of ["app", "gone", "unmanaged"]) {
      await mkdir(join(clones, d));
      await writeFile(join(clones, d, "f.txt"), "x");
    }
    store.addManagedClone(rec("app"));
    store.addManagedClone(rec("gone"));
    const deleted = await removeOutOfScopeClones([scoped("app")], deps);
    expect(deleted.map((d) => d.dir)).toEqual(["gone"]);
    expect(await exists(join(clones, "gone"))).toBe(false);
    expect(await exists(join(clones, "app"))).toBe(true);
    expect(await exists(join(clones, "unmanaged"))).toBe(true);
    expect(store.listManagedClones().map((c) => c.dir)).toEqual(["app"]);
  });

  it("手動指定・KB の dir は managed の記録があっても消さない(大小無視)", async () => {
    const { clones, store, deps } = await setup();
    await mkdir(join(clones, "knowledge-base"));
    await mkdir(join(clones, "Dev-Minutes"));
    store.addManagedClone(rec("knowledge-base"));
    store.addManagedClone(rec("Dev-Minutes"));
    expect(await removeOutOfScopeClones([], deps)).toEqual([]);
    expect(await exists(join(clones, "knowledge-base"))).toBe(true);
    expect(await exists(join(clones, "Dev-Minutes"))).toBe(true);
  });

  it("シンボリックリンク・CLONES_DIR の外・不正な dir 名は消さずに warn(記録は残す)", async () => {
    const { root, clones, store, deps } = await setup();
    const outside = join(root, "precious");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "x");
    await symlink(outside, join(clones, "link"));
    store.addManagedClone(rec("link"));
    store.addManagedClone(rec("../precious"));
    store.addManagedClone(rec(".git"));
    const { logger, warns } = logs();
    const deleted = await removeOutOfScopeClones([], { ...deps, logger });
    expect(deleted).toEqual([]);
    expect(await exists(join(outside, "keep.txt"))).toBe(true);
    expect(await exists(join(clones, "link"))).toBe(true);
    expect(warns.map((w) => w[0].reason).sort()).toEqual([
      "symlink",
      "unsafe_dir_name",
      "unsafe_dir_name",
    ]);
    expect(store.listManagedClones()).toHaveLength(3);
  });

  it("realpath が CLONES_DIR 直下でない(親 dir がリンク等)なら消さない", async () => {
    const { store, deps } = await setup();
    store.addManagedClone(rec("app"));
    const removeDir = vi.fn(async () => {});
    const fs: CloneFs = {
      lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
      realpath: async (p) => (p.endsWith("app") ? "/elsewhere/app" : "/clones"),
      removeDir,
      listDir: async () => [],
    };
    expect(await removeOutOfScopeClones([], { ...deps, fs })).toEqual([]);
    expect(removeDir).not.toHaveBeenCalled();
  });

  it("dir が既に無ければ記録だけ消す", async () => {
    const { store, deps } = await setup();
    store.addManagedClone(rec("vanished"));
    expect((await removeOutOfScopeClones([], deps)).map((d) => d.dir)).toEqual(["vanished"]);
    expect(store.listManagedClones()).toEqual([]);
  });

  it("終了処理が始まっていたら何も消さず、store にも触らない", async () => {
    const { clones, store, deps } = await setup();
    await mkdir(join(clones, "gone"));
    store.addManagedClone(rec("gone"));
    const list = vi.spyOn(store, "listManagedClones");
    expect(await removeOutOfScopeClones([], { ...deps, isStopped: () => true })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(await exists(join(clones, "gone"))).toBe(true);
  });

  it("rm の最中に終了処理が始まったら記録を残して打ち切る(次回は「既に無い」で記録だけ消える)", async () => {
    const { clones, store, deps } = await setup();
    for (const d of ["a", "b"]) {
      await mkdir(join(clones, d));
      store.addManagedClone(rec(d));
    }
    let stopping = false;
    const fs: CloneFs = {
      ...nodeCloneFs,
      removeDir: async (p) => {
        await nodeCloneFs.removeDir(p);
        stopping = true; // rm の完了直後に SIGTERM
      },
    };
    const deleted = await removeOutOfScopeClones([], { ...deps, fs, isStopped: () => stopping });
    expect(deleted).toEqual([]);
    expect(await exists(join(clones, "a"))).toBe(false);
    expect(await exists(join(clones, "b"))).toBe(true);
    expect(store.listManagedClones().map((c) => c.dir)).toEqual(["a", "b"]);
    // 再起動後: a は既に無いので記録だけ消え、b は通常どおり消える。
    expect((await removeOutOfScopeClones([], deps)).map((d) => d.dir)).toEqual(["a", "b"]);
    expect(store.listManagedClones()).toEqual([]);
  });

  it("findStrayEntries: 範囲外・手動/KB 以外・記録の無い直下項目だけを返す", async () => {
    const { clones, store, deps } = await setup();
    for (const d of ["app", "knowledge-base", "managed", "old-board-minutes"]) {
      await mkdir(join(clones, d));
    }
    await writeFile(join(clones, "note.txt"), "x");
    store.addManagedClone(rec("managed"));
    expect(await findStrayEntries([scoped("app")], deps)).toEqual([
      "note.txt",
      "old-board-minutes",
    ]);
    expect(await findStrayEntries([], { ...deps, clonesDir: join(clones, "missing") })).toEqual([]);
    expect(await findStrayEntries([], { ...deps, isStopped: () => true })).toEqual([]);
  });
});

/** 記録用 fake syncer(fail の repo は失敗・empty は空リポ)。order に同期したリポの順を積む。 */
function fakeSyncer(
  order: string[],
  opts: { fail?: string[]; empty?: string[]; onSync?: (spec: RepoSpec) => void } = {},
): RepoSyncer {
  const head = (spec: RepoSpec) => ({
    repo: spec.repo,
    absDir: `/c/${spec.dir}`,
    resolvedCommit: `sha-${spec.dir}`,
  });
  return {
    sync: async () => {
      throw new Error("定期同期・/ask のリポ単位同期は sync を使わない");
    },
    syncEach: async (specs) => {
      const out: RepoSyncResult[] = [];
      for (const spec of specs) {
        order.push(`sync:${spec.dir}`);
        opts.onSync?.(spec);
        await Promise.resolve();
        out.push(
          opts.empty?.includes(spec.repo)
            ? { status: "empty", spec }
            : opts.fail?.includes(spec.repo)
              ? { status: "failed", spec, error: new Error("fetch failed") }
              : { status: "synced", spec, synced: head(spec) },
        );
      }
      return out;
    },
    resolveHead: async () => null,
    inspect: async (spec) => ({ synced: head(spec), clean: true }),
    restoreHead: async (spec) => ({ synced: head(spec), clean: true }),
    fetchTimeOnDisk: async () => null,
  };
}

/** fs fake: existing の dir だけ存在する(削除は記録)。 */
function fakeFs(existing: string[], removed: string[], top: string[] = existing): CloneFs {
  return {
    listDir: async () => [...top],
    lstat: async (p) => {
      if (!existing.some((d) => p.endsWith(`/${d}`))) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { isSymbolicLink: () => false, isDirectory: () => true };
    },
    realpath: async (p) => p,
    removeDir: async (p) => {
      removed.push(p);
    },
  };
}

describe("withManagedCloneRecording(ADR-0036 D4: bot が作る dir だけを記録)", () => {
  function build(existing: string[]) {
    const order: string[] = [];
    const store = createMemoryStore();
    const syncer = withManagedCloneRecording(fakeSyncer(order), {
      store,
      clonesDir: "/c",
      fs: fakeFs(existing, []),
      nowIso: () => "2026-10-07T10:00:00+09:00",
    });
    return { order, store, syncer };
  }

  it("列挙由来で dir がまだ無いものだけを clone 前に記録する(既存 dir・手動指定は記録しない)", async () => {
    const h = build(["preexisting"]);
    const kb = scoped("knowledge-base", { managed: false, syncOnAsk: true });
    const results = await h.syncer.syncEach([kb, scoped("new"), scoped("preexisting")]);
    expect(results.map((r) => [r.spec.dir, r.status])).toEqual([
      ["knowledge-base", "synced"],
      ["new", "synced"],
      ["preexisting", "synced"],
    ]);
    expect(h.store.listManagedClones()).toEqual([
      { dir: "new", repo: "org/new", createdAt: "2026-10-07T10:00:00+09:00" },
    ]);
  });

  it("記録できない(bot.db が閉じた等)リポは clone せず failed で返す(他のリポは続行・順序を保つ)", async () => {
    const h = build([]);
    vi.spyOn(h.store, "addManagedClone").mockImplementation(() => {
      throw new Error("The database connection is not open");
    });
    const kb = scoped("knowledge-base", { managed: false, syncOnAsk: true });
    const results = await h.syncer.syncEach([scoped("new"), kb]);
    expect(results.map((r) => [r.spec.dir, r.status])).toEqual([
      ["new", "failed"],
      ["knowledge-base", "synced"],
    ]);
    expect(h.order).toEqual(["sync:knowledge-base"]);
  });

  it("/ask(syncForAskPerRepo)が sync_on_ask の列挙分を初回 clone しても記録される", async () => {
    const h = build([]);
    const minutes = scoped("biz-minutes", { syncOnAsk: true });
    const registry = createRepoRegistry([minutes]);
    const out = await syncForAskPerRepo(
      { getRepos: () => registry.scope(), syncer: h.syncer },
      { registry, nowMs: () => 1_000 },
    );
    expect(out.available.map((r) => r.repo)).toEqual(["org/biz-minutes"]);
    expect(h.store.listManagedClones().map((c) => c.dir)).toEqual(["biz-minutes"]);
  });
});

describe("createPeriodicRepoSync(ADR-0036 D5)", () => {
  function build(opts: {
    initial: ScopedRepo[];
    next: ScopedRepo[] | null;
    existing?: string[];
    fail?: string[];
    empty?: string[];
    top?: string[];
    chunkSize?: number;
    queue?: SerialQueue;
    nowMs?: () => number;
    isStopped?: () => boolean;
    onSync?: (spec: RepoSpec) => void;
  }) {
    const order: string[] = [];
    const removed: string[] = [];
    const store = createMemoryStore();
    const registry = createRepoRegistry(opts.initial);
    const queue = opts.queue ?? new SerialQueue();
    const { logger, infos, warns } = logs();
    const resolveScope = vi.fn(async () => opts.next);
    const fs = fakeFs(opts.existing ?? [], removed, opts.top);
    const syncer = withManagedCloneRecording(
      fakeSyncer(order, {
        ...(opts.fail !== undefined ? { fail: opts.fail } : {}),
        ...(opts.empty !== undefined ? { empty: opts.empty } : {}),
        ...(opts.onSync !== undefined ? { onSync: opts.onSync } : {}),
      }),
      { store, clonesDir: "/c", fs, nowIso: () => "2026-10-07T10:00:00+09:00" },
    );
    const runner = createPeriodicRepoSync({
      registry,
      syncer,
      resolveScope,
      enqueue: (t) => queue.enqueue(t),
      cleanup: {
        store,
        clonesDir: "/c",
        protectedDirs: ["knowledge-base"],
        fs,
        logger,
        ...(opts.isStopped !== undefined ? { isStopped: opts.isStopped } : {}),
      },
      ...(opts.chunkSize !== undefined ? { chunkSize: opts.chunkSize } : {}),
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      logger,
    });
    return { runner, order, removed, store, registry, queue, infos, warns, resolveScope };
  }

  const kb = scoped("knowledge-base", { managed: false, syncOnAsk: true });

  it("範囲を差し替え、全対象リポを同期して fetch の成功(時刻つき)として registry に記録する", async () => {
    const h = build({ initial: [kb], next: [kb, scoped("a"), scoped("b")], nowMs: () => 5_000 });
    await h.runner.runOnce();
    expect(h.registry.scope().map((r) => r.dir)).toEqual(["knowledge-base", "a", "b"]);
    expect(h.order).toEqual(["sync:knowledge-base", "sync:a", "sync:b"]);
    expect(h.registry.lastSynced("org/a")?.resolvedCommit).toBe("sha-a");
    // 段階 1-2 の TTL 再利用・許容期間はこの時刻を見る。
    expect(h.registry.lastFetchedAt("org/a")).toBe(5_000);
    expect(h.registry.lastFetchedAt("org/knowledge-base")).toBe(5_000);
    expect(h.infos.at(-1)?.[0]).toMatchObject({ repos: 3, synced: 3, failed: 0, deleted: 0 });
  });

  it("鮮度確認で無効化された KB も、定期同期の成功で無効化が解ける(reset --hard 済み)", async () => {
    const h = build({ initial: [kb], next: [kb] });
    h.registry.invalidate("org/knowledge-base");
    await h.runner.runOnce();
    expect(h.registry.isInvalidated("org/knowledge-base")).toBe(false);
  });

  it("bot が新規に作る managed dir だけを記録する(既存 dir・手動指定は記録しない)", async () => {
    const h = build({
      initial: [kb],
      next: [kb, scoped("new"), scoped("preexisting")],
      existing: ["knowledge-base", "preexisting"],
    });
    await h.runner.runOnce();
    expect(h.store.listManagedClones().map((c) => c.dir)).toEqual(["new"]);
  });

  it("範囲外になった managed clone を削除し、registry からも消す", async () => {
    const h = build({ initial: [kb, scoped("old")], next: [kb], existing: ["old"] });
    h.store.addManagedClone({ dir: "old", repo: "org/old", createdAt: "t" });
    h.registry.recordSynced({ repo: "org/old", absDir: "/c/old", resolvedCommit: "s" });
    await h.runner.runOnce();
    expect(h.removed).toEqual(["/c/old"]);
    expect(h.store.listManagedClones()).toEqual([]);
    expect(h.registry.lastSynced("org/old")).toBeUndefined();
  });

  it("列挙に失敗した回は前回の範囲のまま同期し、削除しない", async () => {
    const h = build({ initial: [kb, scoped("a")], next: null, existing: ["gone"] });
    h.store.addManagedClone({ dir: "gone", repo: "org/gone", createdAt: "t" });
    await h.runner.runOnce();
    expect(h.registry.scope().map((r) => r.dir)).toEqual(["knowledge-base", "a"]);
    expect(h.order).toEqual(["sync:knowledge-base", "sync:a"]);
    expect(h.removed).toEqual([]);
    expect(h.infos.at(-1)?.[0]).toMatchObject({ scopeRefreshed: false });
  });

  it("scope を渡すと再列挙せずにそれを使う(起動時の列挙結果の再利用)", async () => {
    const h = build({ initial: [kb], next: [kb] });
    await h.runner.runOnce({ scope: [kb, scoped("a")] });
    expect(h.resolveScope).not.toHaveBeenCalled();
    expect(h.order).toEqual(["sync:knowledge-base", "sync:a"]);
  });

  it("空リポ(commit 無し)は失敗として warn せず、registry に空として記録する", async () => {
    const h = build({
      initial: [kb],
      next: [kb, scoped("sales-management"), scoped("a")],
      empty: ["org/sales-management"],
    });
    await h.runner.runOnce();
    expect(h.registry.isEmpty("org/sales-management")).toBe(true);
    expect(h.registry.lastError("org/sales-management")).toBeUndefined();
    expect(h.warns).toEqual([]);
    expect(h.infos.at(-1)?.[0]).toMatchObject({ synced: 2, empty: 1, failed: 0 });
  });

  it("範囲外かつ記録の無い CLONES_DIR 直下の項目を warn する(消さない・同じ一覧は繰り返さない)", async () => {
    const h = build({
      initial: [kb],
      next: [kb, scoped("a")],
      existing: ["knowledge-base", "a", "managed-old", "board-minutes"],
      top: ["knowledge-base", "a", "board-minutes", ".stray", "managed-old"],
    });
    h.store.addManagedClone({ dir: "a", repo: "org/a", createdAt: "t" });
    await h.runner.runOnce();
    const strayWarns = (): LogCall[] => h.warns.filter((w) => Array.isArray(w[0].entries));
    expect(strayWarns()).toHaveLength(1);
    expect(strayWarns()[0]?.[0].entries).toEqual([".stray", "board-minutes", "managed-old"]);
    expect(h.removed).toEqual([]); // 記録の無い項目は消さない
    await h.runner.runOnce();
    expect(strayWarns()).toHaveLength(1); // 一覧が同じなら再 warn しない
  });

  it("リポ単位の失敗は warn して続行し registry に失敗を残す", async () => {
    const h = build({ initial: [kb], next: [kb, scoped("a"), scoped("b")], fail: ["org/a"] });
    await h.runner.runOnce();
    expect(h.order).toEqual(["sync:knowledge-base", "sync:a", "sync:b"]);
    expect(h.registry.lastError("org/a")).toBe("fetch failed");
    expect(h.warns.some((w) => w[0].repo === "org/a")).toBe(true);
    expect(h.infos.at(-1)?.[0]).toMatchObject({ synced: 2, failed: 1 });
  });

  it("チャンク単位でキューに積み、合間に /ask が割り込める(初回 clone で待たせ続けない)", async () => {
    const queue = new SerialQueue();
    let ask: Promise<void> | undefined;
    const events: string[] = [];
    const h = build({
      initial: [kb],
      next: [kb, ...["a", "b", "c", "d"].map((n) => scoped(n))],
      chunkSize: 2,
      queue,
      onSync: (spec) => {
        events.push(`sync:${spec.dir}`);
        // 最初のチャンクの実行中に /ask が来る。
        if (ask === undefined) {
          ask = queue.enqueue(async () => {
            events.push("ask");
          });
        }
      },
    });
    await h.runner.runOnce();
    await ask;
    // /ask は全リポの同期完了を待たず、最初のチャンク(2 件)の直後に実行される。
    expect(events).toEqual(["sync:knowledge-base", "sync:a", "ask", "sync:b", "sync:c", "sync:d"]);
  });

  it("キュー上の定期同期タスクは常に高々 1 件", async () => {
    const queue = new SerialQueue();
    const h = build({
      initial: [kb],
      next: [kb, ...["a", "b", "c", "d", "e"].map((n) => scoped(n))],
      chunkSize: 1,
      queue,
    });
    let maxPending = 0;
    const origEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = <T>(t: () => Promise<T>): Promise<T> => {
      const p = origEnqueue(t);
      maxPending = Math.max(maxPending, queue.pending);
      return p;
    };
    await h.runner.runOnce();
    expect(maxPending).toBe(1);
  });

  it("実行中に呼ばれた runOnce は skip(初回 clone が間隔より長くても重ならない)", async () => {
    const h = build({ initial: [kb], next: [kb] });
    const first = h.runner.runOnce();
    await h.runner.runOnce();
    await first;
    expect(h.resolveScope).toHaveBeenCalledTimes(1);
  });

  it("start は intervalMs ごとに runOnce を起動し、stop で止まる(fake timer)", async () => {
    vi.useFakeTimers();
    try {
      const h = build({ initial: [kb], next: [kb] });
      h.runner.start(600_000);
      h.runner.start(600_000); // 二重起動しない
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.resolveScope).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.resolveScope).toHaveBeenCalledTimes(2);
      h.runner.stop();
      await vi.advanceTimersByTimeAsync(1_200_000);
      expect(h.resolveScope).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("正常終了(ADR-0035 追記)との関係", () => {
    it("stop() 後の runOnce・start は何もしない(bot.db にも触らない)", async () => {
      const h = build({ initial: [kb], next: [kb, scoped("a")] });
      const list = vi.spyOn(h.store, "listManagedClones");
      h.runner.stop();
      await h.runner.runOnce();
      h.runner.start(1_000);
      expect(h.resolveScope).not.toHaveBeenCalled();
      expect(h.order).toEqual([]);
      expect(list).not.toHaveBeenCalled();
    });

    it("実行中に stop() されたら次のリポ・チャンクへ進まず、以後 store に書かない", async () => {
      let runner: { stop(): void } | undefined;
      const h = build({
        initial: [kb],
        next: [kb, ...["a", "b", "c", "d"].map((n) => scoped(n))],
        chunkSize: 3,
        onSync: (spec) => {
          if (spec.dir === "a") runner?.stop(); // a の git の最中に SIGTERM
        },
      });
      runner = h.runner;
      const add = vi.spyOn(h.store, "addManagedClone");
      await h.runner.runOnce();
      expect(h.order).toEqual(["sync:knowledge-base", "sync:a"]);
      // a は stop 前に記録済み。b 以降は記録も clone もしない。
      expect(add.mock.calls.map((c) => c[0].dir)).toEqual(["a"]);
      expect(h.infos.at(-1)?.[0]).toMatchObject({ interrupted: true, synced: 2 });
      expect(h.infos.at(-1)?.[1]).toContain("打ち切りました");
    });

    it("終了処理の開始(/ask の受付停止 = isStopped)でも同じく打ち切る・以後のタイマ起動は何もしない", async () => {
      let shuttingDown = false;
      const h = build({
        initial: [kb],
        next: [kb, scoped("a"), scoped("b")],
        chunkSize: 1,
        isStopped: () => shuttingDown,
        onSync: (spec) => {
          if (spec.dir === "knowledge-base") shuttingDown = true;
        },
      });
      await h.runner.runOnce();
      expect(h.order).toEqual(["sync:knowledge-base"]);
      expect(h.store.listManagedClones()).toEqual([]);
      await h.runner.runOnce();
      expect(h.resolveScope).toHaveBeenCalledTimes(1);
    });

    it("範囲の差し替えタスクが始まる前に終了処理が始まったら、範囲も clone も変えない", async () => {
      const queue = new SerialQueue();
      let shuttingDown = false;
      // /ask が実行中(キューを占有)の間に定期同期が積まれ、その /ask の最中に SIGTERM が来る。
      let releaseAsk: () => void = () => {};
      const askRunning = queue.enqueue(
        () =>
          new Promise<void>((res) => {
            releaseAsk = res;
          }),
      );
      const h = build({
        initial: [kb],
        next: [kb, scoped("a")],
        existing: ["gone"],
        queue,
        isStopped: () => shuttingDown,
      });
      h.store.addManagedClone({ dir: "gone", repo: "org/gone", createdAt: "t" });
      const run = h.runner.runOnce();
      await Promise.resolve();
      shuttingDown = true;
      releaseAsk();
      await askRunning;
      await run;
      expect(h.registry.scope().map((r) => r.dir)).toEqual(["knowledge-base"]);
      expect(h.removed).toEqual([]);
      expect(h.order).toEqual([]);
    });
  });

  it("定期同期の結果を /ask(syncForAskPerRepo・段階 1-2)がそのまま使う: sync_on_ask 外は fetch せず引用でき、TTL 内は再利用", async () => {
    const h = build({
      initial: [kb],
      next: [kb, scoped("app"), scoped("biz-minutes", { syncOnAsk: true })],
      nowMs: () => 10_000,
    });
    await h.runner.runOnce();
    h.order.length = 0;
    const out = await syncForAskPerRepo(
      { getRepos: () => h.registry.scope(), syncer: fakeSyncer(h.order) },
      { registry: h.registry, ttlMs: 60_000, nowMs: () => 20_000 },
    );
    // TTL 内(10 秒前に定期同期)なので fetch しない。app(sync_on_ask 外)も定期同期の SHA で引用できる。
    expect(h.order).toEqual([]);
    expect(out.available.map((r) => r.repo)).toEqual([
      "org/knowledge-base",
      "org/app",
      "org/biz-minutes",
    ]);
    expect(out.synced.find((s) => s.repo === "org/app")?.resolvedCommit).toBe("sha-app");
    expect(out.metrics).toMatchObject({ reposReused: 2, reposFetched: 0 });
  });
});
