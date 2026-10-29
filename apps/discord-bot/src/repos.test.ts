import { execFile } from "node:child_process";
import { access, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitRepoSyncer,
  type GitExec,
  type RepoFs,
  type RepoSpec,
  stripCredentials,
} from "./repos.js";

const execFileAsync = promisify(execFile);

const TOKEN_URL = "https://x-access-token:SECRET@github.com/org/knowledge-base.git";
const CLEAN_URL = "https://github.com/org/knowledge-base.git";

/** exec 記録 fake。existingDirs に含む dir は独立リポ(--git-dir ".git")、それ以外は probe throw。 */
function fakeExec(existingDirs: readonly string[]): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push([...args]);
    if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--git-dir") {
      const dir = args[1] ?? "";
      if (!existingDirs.some((d) => dir.endsWith(`/${d}`))) throw new Error("not a repo");
      return { stdout: ".git\n" };
    }
    return { stdout: "abc123\n" };
  };
  return { exec, calls };
}

describe("stripCredentials", () => {
  it("userinfo を除去する", () => {
    expect(stripCredentials(TOKEN_URL)).toBe(CLEAN_URL);
    expect(stripCredentials(CLEAN_URL)).toBe(CLEAN_URL);
  });
});

describe("createGitRepoSyncer(トークン非永続化・ADR-0013 D1(b) と同流儀)", () => {
  const spec: RepoSpec = { repo: "org/knowledge-base", dir: "knowledge-base", url: TOKEN_URL };
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  // syncer は実 mkdir(clonesDir) を行うため、fake テストでも書き込める実 tmp dir を使う。
  const makeClonesDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "bot-repos-fake-"));
    tmpDirs.push(d);
    return d;
  };

  it("新規 clone の直後に remote URL をトークン無しへ差し替える(順序も固定)", async () => {
    const c = await makeClonesDir();
    const { exec, calls } = fakeExec([]);
    const [r] = await createGitRepoSyncer(c, exec).sync([spec]);
    expect(r?.resolvedCommit).toBe("abc123");
    const kb = join(c, "knowledge-base");
    const cloneIdx = calls.findIndex((a) => a[0] === "clone");
    const scrubIdx = calls.findIndex((a) => a.includes("set-url"));
    expect(calls[cloneIdx]).toEqual([
      "clone",
      "-c",
      "core.symlinks=false", // ADR-0037: symlink を通常ファイルとして展開
      "--depth=1",
      TOKEN_URL,
      kb,
    ]);
    expect(calls[scrubIdx]).toEqual(["-C", kb, "remote", "set-url", "origin", CLEAN_URL]);
    expect(scrubIdx).toBeGreaterThan(cloneIdx);
  });

  it("既存 clone + url は冪等 scrub → URL 引数 fetch(origin 非依存)→ reset → clean の順", async () => {
    const c = await makeClonesDir();
    const { exec, calls } = fakeExec(["knowledge-base"]);
    await createGitRepoSyncer(c, exec).sync([spec]);
    const kb = join(c, "knowledge-base");
    // 冪等 scrub: 旧 clone の残留トークンを毎 sync で無害化(remote 不在でも通る config 書き)。
    expect(calls).toContainEqual(["-C", kb, "config", "remote.origin.url", CLEAN_URL]);
    // fetch はスクラブ済み origin に依存せず url 引数で行う(トークンを config に残さない前提)。
    expect(calls).toContainEqual(["-C", kb, "fetch", "--depth=1", TOKEN_URL]);
    expect(calls.some((a) => a.includes("fetch") && a.includes("origin"))).toBe(false);
    const idx = (op: string): number => calls.findIndex((a) => a.includes(op));
    expect(calls[idx("reset")]).toEqual([
      "-C",
      kb,
      "-c",
      "core.symlinks=false",
      "reset",
      "--hard",
      "FETCH_HEAD",
    ]);
    expect(calls[idx("clean")]).toEqual(["-C", kb, "clean", "-fd"]);
    expect(idx("config")).toBeLessThan(idx("fetch"));
    expect(idx("clean")).toBeGreaterThan(idx("reset"));
    // ADR-0037: 未移行(fake の config --get は "false" を返さない)なら reset 前に index を空にし、
    // 再展開の成功後に core.symlinks=false を永続化する。
    expect(idx("read-tree")).toBeGreaterThan(idx("fetch"));
    expect(idx("read-tree")).toBeLessThan(idx("reset"));
    const persistIdx = calls.findIndex(
      (a) => a.join(" ") === `-C ${kb} config core.symlinks false`,
    );
    expect(persistIdx).toBeGreaterThan(idx("clean"));
  });

  it("移行済み(core.symlinks=false)の既存 clone は read-tree も config 書きもしない", async () => {
    const c = await makeClonesDir();
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      if (args[2] === "rev-parse" && args[3] === "--git-dir") return { stdout: ".git\n" };
      if (args[2] === "config" && args[3] === "--get") return { stdout: "false\n" };
      return { stdout: "abc123\n" };
    };
    await createGitRepoSyncer(c, exec).sync([spec]);
    expect(calls.some((a) => a.includes("read-tree"))).toBe(false);
    expect(calls.some((a) => a.join(" ").endsWith("config core.symlinks false"))).toBe(false);
  });

  it("url 無しの既存 dir は fetch/reset/clean/clone せず rev-parse のみ(synthetic 温存)", async () => {
    const c = await makeClonesDir();
    const { exec, calls } = fakeExec(["minutes"]);
    const [r] = await createGitRepoSyncer(c, exec).sync([{ repo: "org/minutes", dir: "minutes" }]);
    expect(r?.resolvedCommit).toBe("abc123");
    expect(
      calls.some(
        (a) =>
          a.includes("fetch") ||
          a.includes("reset") ||
          a.includes("clean") ||
          a.includes("config") ||
          a.includes("set-url") ||
          a[0] === "clone",
      ),
    ).toBe(false);
  });

  it("親リポの内側(--git-dir が相対 .git 以外)は破壊的操作をせず throw", async () => {
    const c = await makeClonesDir();
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      if (args[2] === "rev-parse" && args[3] === "--git-dir") return { stdout: "../.git\n" };
      return { stdout: "abc123\n" };
    };
    await expect(createGitRepoSyncer(c, exec).sync([spec])).rejects.toThrow(
      /独立した git リポではありません/,
    );
    expect(
      calls.some(
        (a) =>
          a.includes("fetch") ||
          a.includes("reset") ||
          a.includes("clean") ||
          a.includes("config") ||
          a.includes("set-url") ||
          a[0] === "clone",
      ),
    ).toBe(false);
  });
});

describe("createGitRepoSyncer.syncEach / resolveHead(リポ単位・ADR-0036 D5)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const makeClonesDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "bot-repos-each-"));
    tmpDirs.push(d);
    return d;
  };

  it("1 リポの失敗で後続を止めず、specs と同順にリポ単位の成否を返す(throw しない)", async () => {
    const c = await makeClonesDir();
    const specs: RepoSpec[] = [
      { repo: "org/a", dir: "a", url: "https://github.com/org/a.git" },
      { repo: "org/b", dir: "b", url: "https://github.com/org/b.git" },
      { repo: "org/c", dir: "c", url: "https://github.com/org/c.git" },
    ];
    const exec: GitExec = async (args) => {
      if (args[2] === "rev-parse" && args[3] === "--git-dir") return { stdout: ".git\n" };
      if (args.includes("fetch") && args[1]?.endsWith("/b")) throw new Error("network down");
      return { stdout: "sha\n" };
    };
    const results = await createGitRepoSyncer(c, exec).syncEach(specs);
    expect(results.map((r) => [r.spec.repo, r.status])).toEqual([
      ["org/a", "synced"],
      ["org/b", "failed"],
      ["org/c", "synced"],
    ]);
    const failed = results[1];
    expect(failed?.status === "failed" && String(failed.error)).toContain("network down");
  });

  it("sync は従来どおり最初の失敗で throw する(all_visible 無しの挙動を変えない)", async () => {
    const c = await makeClonesDir();
    const exec: GitExec = async (args) => {
      if (args.includes("fetch")) throw new Error("network down");
      return { stdout: ".git\n" };
    };
    await expect(
      createGitRepoSyncer(c, exec).sync([
        { repo: "org/a", dir: "a", url: "https://github.com/org/a.git" },
      ]),
    ).rejects.toThrow("network down");
  });

  it("resolveHead は fetch せず rev-parse HEAD のみ。clone 無し・親リポの内側は null", async () => {
    const c = await makeClonesDir();
    const { exec, calls } = fakeExec(["a"]);
    const syncer = createGitRepoSyncer(c, exec);
    const a = await syncer.resolveHead({ repo: "org/a", dir: "a", url: "https://x/a.git" });
    expect(a).toEqual({ repo: "org/a", absDir: join(c, "a"), resolvedCommit: "abc123" });
    expect(calls.some((x) => x.includes("fetch") || x[0] === "clone")).toBe(false);
    expect(await syncer.resolveHead({ repo: "org/b", dir: "b" })).toBeNull();

    const nested: GitExec = async (args) =>
      args[3] === "--git-dir" ? { stdout: "../.git\n" } : { stdout: "parent-sha\n" };
    expect(
      await createGitRepoSyncer(c, nested).resolveHead({ repo: "org/a", dir: "a" }),
    ).toBeNull();
  });
});

describe("createGitRepoSyncer.inspect / restoreHead(TTL 再利用の確認・段階 1-2)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const makeClonesDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "bot-repos-inspect-"));
    tmpDirs.push(d);
    return d;
  };
  /** status --porcelain の出力を差し替えられる fake。rev-parse HEAD は "sha1"。 */
  function statusExec(status: () => string): { exec: GitExec; calls: string[][] } {
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      if (args[2] === "rev-parse" && args[3] === "--git-dir") return { stdout: ".git\n" };
      if (args[2] === "rev-parse" && args[3] === "HEAD") return { stdout: "sha1\n" };
      if (args[2] === "status") return { stdout: status() };
      return { stdout: "" };
    };
    return { exec, calls };
  }
  const spec: RepoSpec = { repo: "org/a", dir: "a", url: "https://x@github.com/org/a.git" };

  it("inspect は rev-parse HEAD と status --porcelain だけで HEAD とクリーンさを返す(fetch しない)", async () => {
    const c = await makeClonesDir();
    let out = "";
    const { exec, calls } = statusExec(() => out);
    const syncer = createGitRepoSyncer(c, exec);
    expect(await syncer.inspect(spec)).toEqual({
      synced: { repo: "org/a", absDir: join(c, "a"), resolvedCommit: "sha1" },
      clean: true,
    });
    out = " M notes.md\n?? litter.md\n";
    expect((await syncer.inspect(spec))?.clean).toBe(false);
    expect(calls).toContainEqual(["-C", join(c, "a"), "status", "--porcelain"]);
    // 未追跡を除外するオプション(-uno 等)は付けない。ネットワーク系・書き込み系は叩かない。
    expect(calls.some((a) => a.some((x) => x.startsWith("-u") || x === "--ignored"))).toBe(false);
    expect(
      calls.some((a) =>
        ["fetch", "reset", "clean", "clone", "ls-remote"].some((op) => a.includes(op)),
      ),
    ).toBe(false);
  });

  it("clone が無い・親リポの内側なら inspect / restoreHead は null(何も書き換えない)", async () => {
    const c = await makeClonesDir();
    const { exec, calls } = fakeExec([]);
    const syncer = createGitRepoSyncer(c, exec);
    expect(await syncer.inspect(spec)).toBeNull();
    expect(await syncer.restoreHead(spec)).toBeNull();
    expect(calls.some((a) => a.includes("reset") || a.includes("clean"))).toBe(false);
  });

  it("restoreHead はローカルの HEAD へ reset --hard(core.symlinks=false)+ clean -fd する(fetch しない)", async () => {
    const c = await makeClonesDir();
    const { exec, calls } = statusExec(() => "");
    const r = await createGitRepoSyncer(c, exec).restoreHead(spec);
    expect(r?.clean).toBe(true);
    const a = join(c, "a");
    expect(calls).toContainEqual(["-C", a, "-c", "core.symlinks=false", "reset", "--hard", "HEAD"]);
    expect(calls).toContainEqual(["-C", a, "clean", "-fd"]);
    expect(calls.some((x) => x.includes("fetch"))).toBe(false);
  });
});

describe("createGitRepoSyncer.fetchTimeOnDisk(再起動直後の最終成功時刻・段階 1-2)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const spec: RepoSpec = { repo: "org/a", dir: "a" };
  /** clone は独立リポで HEAD は "sha1"。fs は与えた内容だけを返す fake。 */
  async function make(files: Record<string, { text?: string; mtime: number }>) {
    const c = await mkdtemp(join(tmpdir(), "bot-repos-fetchtime-"));
    tmpDirs.push(c);
    const exec: GitExec = async (args) =>
      args[3] === "--git-dir" ? { stdout: ".git\n" } : { stdout: "sha1\n" };
    const fs: RepoFs = {
      mtimeMs: async (p) => files[p.slice(c.length + 1)]?.mtime ?? null,
      readText: async (p) => files[p.slice(c.length + 1)]?.text ?? null,
    };
    return createGitRepoSyncer(c, exec, fs);
  }

  it("FETCH_HEAD の SHA が HEAD と一致すればその更新時刻", async () => {
    const s = await make({
      "a/.git/FETCH_HEAD": { text: "sha1\t\thttps://github.com/org/a\n", mtime: 111 },
      "a/.git/HEAD": { text: "ref: refs/heads/main\n", mtime: 5 },
    });
    expect(await s.fetchTimeOnDisk(spec)).toBe(111);
  });

  it("FETCH_HEAD の SHA が HEAD と違う(fetch 後の reset が完了していない)なら null", async () => {
    const s = await make({
      "a/.git/FETCH_HEAD": { text: "other\t\turl\n", mtime: 111 },
      "a/.git/HEAD": { text: "ref: refs/heads/main\n", mtime: 5 },
    });
    expect(await s.fetchTimeOnDisk(spec)).toBeNull();
  });

  it("FETCH_HEAD が無い(clone 後に fetch していない)なら .git/HEAD の更新時刻。clone 無しは null", async () => {
    const s = await make({ "a/.git/HEAD": { text: "ref: refs/heads/main\n", mtime: 5 } });
    expect(await s.fetchTimeOnDisk(spec)).toBe(5);
    const c = await mkdtemp(join(tmpdir(), "bot-repos-fetchtime-"));
    tmpDirs.push(c);
    const { exec } = fakeExec([]);
    expect(await createGitRepoSyncer(c, exec).fetchTimeOnDisk(spec)).toBeNull();
  });
});

describe("createGitRepoSyncer の高速化(並列・fast 経路・reset の省略・ADR-0035 追記 2026-10-08)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const makeClonesDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "bot-repos-fast-"));
    tmpDirs.push(d);
    return d;
  };
  const spec: RepoSpec = { repo: "org/a", dir: "a", url: "https://x@github.com/org/a.git" };

  /**
   * 状態を持つ fake git(既存 clone・移行済み)。fetch は remote の SHA を FETCH_HEAD に置き、
   * reset --hard は HEAD を FETCH_HEAD へ進めて作業ツリーをクリーンにする。
   * `.git/config` の更新時刻は configMtime(fs fake で返す)。
   */
  function stateful() {
    const st = {
      head: "sha1",
      remote: "sha1",
      fetched: "",
      status: "",
      symlinks: "false" as string | null,
      configMtime: 100,
      failFetch: false,
    };
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      const op = args[2];
      if (op === "rev-parse" && args[3] === "--git-dir") return { stdout: ".git\n" };
      if (op === "rev-parse" && args[3] === "HEAD" && args[4] === "FETCH_HEAD") {
        return { stdout: `${st.head}\n${st.fetched}\n` };
      }
      if (op === "rev-parse") return { stdout: `${st.head}\n` };
      if (op === "config" && args[3] === "--get") {
        if (st.symlinks === null) throw new Error("exit 1");
        return { stdout: `${st.symlinks}\n` };
      }
      if (op === "fetch") {
        if (st.failFetch) throw new Error("network down");
        st.fetched = st.remote;
      }
      if (op === "status") return { stdout: st.status };
      if (args.includes("reset")) {
        st.head = st.fetched;
        st.status = "";
      }
      return { stdout: "" };
    };
    const fs: RepoFs = {
      mtimeMs: async (p) => (p.endsWith("/.git/config") ? st.configMtime : null),
      readText: async () => null,
    };
    const ops = (from = 0): string[] =>
      calls.slice(from).map((a) => (a[0] === "-C" ? a.slice(2) : a).join(" "));
    return { st, calls, exec, fs, ops };
  }

  it("syncEach は複数リポを並列に同期し、結果は specs と同順で返す", async () => {
    const c = await makeClonesDir();
    let active = 0;
    let maxActive = 0;
    const exec: GitExec = async (args) => {
      if (args[2] === "rev-parse" && args[3] === "--git-dir") return { stdout: ".git\n" };
      if (args[2] === "fetch") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
      }
      return { stdout: `${args[1]?.endsWith("/a") ? "sha-a" : "sha-b"}\n` };
    };
    const results = await createGitRepoSyncer(c, exec).syncEach([
      { repo: "org/a", dir: "a", url: "https://github.com/org/a.git" },
      { repo: "org/b", dir: "b", url: "https://github.com/org/b.git" },
    ]);
    expect(maxActive).toBe(2); // 2 リポの fetch が同時に走った
    expect(
      results.map((r) => (r.status === "synced" ? r.synced.resolvedCommit : r.status)),
    ).toEqual(["sha-a", "sha-b"]);
  });

  it("同じ dir が重複して渡されたら直列にする(同一 clone へ同時に書き込まない)", async () => {
    const c = await makeClonesDir();
    let active = 0;
    let maxActive = 0;
    const exec: GitExec = async (args) => {
      if (args[2] === "rev-parse" && args[3] === "--git-dir") return { stdout: ".git\n" };
      if (args[2] === "fetch") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      }
      return { stdout: "sha\n" };
    };
    const s: RepoSpec = { repo: "org/a", dir: "a", url: "https://github.com/org/a.git" };
    const results = await createGitRepoSyncer(c, exec).syncEach([s, s]);
    expect(maxActive).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["synced", "synced"]);
  });

  it("2 回目以降は scrub・HEAD 有無・core.symlinks の確認を省き、変化もクリーンなら reset/clean も省く", async () => {
    const c = await makeClonesDir();
    const g = stateful();
    const syncer = createGitRepoSyncer(c, g.exec, g.fs);
    const [first] = await syncer.syncEach([spec]);
    // 初回(full 経路): scrub・HEAD 有無・symlink 移行の確認をする。
    expect(g.ops()).toContain(
      `config remote.origin.url ${CLEAN_URL.replace("knowledge-base", "a")}`,
    );
    expect(g.ops()).toContain("rev-parse --verify -q HEAD");
    expect(g.ops()).toContain("config --get core.symlinks");
    // fetch の結果が HEAD と同じでクリーンなので、初回でも reset/clean は省く。
    expect(first?.status === "synced" && first.resetSkipped).toBe(true);

    const mark = g.calls.length;
    const [second] = await syncer.syncEach([spec]);
    expect(g.ops(mark)).toEqual([
      "rev-parse --git-dir", // 独立リポの確認は毎回(ADR-0037・親リポ破壊の防止)
      `fetch --depth=1 ${spec.url}`,
      "rev-parse HEAD FETCH_HEAD",
      "status --porcelain",
    ]);
    expect(second).toMatchObject({
      status: "synced",
      resetSkipped: true,
      synced: { resolvedCommit: "sha1" },
    });
  });

  it("fetch で HEAD が進んだら reset/clean する(status は見ない)", async () => {
    const c = await makeClonesDir();
    const g = stateful();
    const syncer = createGitRepoSyncer(c, g.exec, g.fs);
    await syncer.syncEach([spec]);
    g.st.remote = "sha2";
    const mark = g.calls.length;
    const [r] = await syncer.syncEach([spec]);
    expect(g.ops(mark)).toEqual([
      "rev-parse --git-dir",
      `fetch --depth=1 ${spec.url}`,
      "rev-parse HEAD FETCH_HEAD",
      "-c core.symlinks=false reset --hard FETCH_HEAD",
      "clean -fd",
      "rev-parse HEAD",
    ]);
    expect(r).toMatchObject({
      status: "synced",
      resetSkipped: false,
      synced: { resolvedCommit: "sha2" },
    });
  });

  it("HEAD が同じでも作業ツリーが汚れていれば(書き込み・未追跡の残骸)reset/clean する", async () => {
    const c = await makeClonesDir();
    const g = stateful();
    const syncer = createGitRepoSyncer(c, g.exec, g.fs);
    await syncer.syncEach([spec]);
    g.st.status = "?? litter.md\n";
    const mark = g.calls.length;
    const [r] = await syncer.syncEach([spec]);
    expect(g.ops(mark)).toContain("status --porcelain");
    expect(g.ops(mark)).toContain("-c core.symlinks=false reset --hard FETCH_HEAD");
    expect(g.ops(mark)).toContain("clean -fd");
    expect(r).toMatchObject({ status: "synced", resetSkipped: false });
  });

  it("`.git/config` が変わった・同期に失敗した後は full 経路(scrub・確認)に戻る", async () => {
    const c = await makeClonesDir();
    const g = stateful();
    const syncer = createGitRepoSyncer(c, g.exec, g.fs);
    const scrubbed = (from: number): boolean =>
      g.ops(from).some((o) => o.startsWith("config remote.origin.url"));
    await syncer.syncEach([spec]);
    // 手動の再 clone・他プロセスの origin 書き換え等で config が変わった。
    g.st.configMtime = 200;
    let mark = g.calls.length;
    await syncer.syncEach([spec]);
    expect(scrubbed(mark)).toBe(true);
    // 確認し直した後は再び fast 経路。
    mark = g.calls.length;
    await syncer.syncEach([spec]);
    expect(scrubbed(mark)).toBe(false);
    // 同期に失敗したら次回は full 経路。
    g.st.failFetch = true;
    expect((await syncer.syncEach([spec]))[0]?.status).toBe("failed");
    g.st.failFetch = false;
    mark = g.calls.length;
    await syncer.syncEach([spec]);
    expect(scrubbed(mark)).toBe(true);
    expect(g.ops(mark)).toContain("config --get core.symlinks");
  });

  it("config の時刻が取れない clone は毎回 full 経路", async () => {
    const c = await makeClonesDir();
    const g = stateful();
    const syncer = createGitRepoSyncer(c, g.exec, { ...g.fs, mtimeMs: async () => null });
    await syncer.syncEach([spec]);
    const mark = g.calls.length;
    await syncer.syncEach([spec]);
    expect(g.ops(mark)).toContain("config --get core.symlinks");
  });

  it("未移行(core.symlinks 未設定)の clone は fetch 結果が同じでも index を空にして reset する", async () => {
    const c = await makeClonesDir();
    const g = stateful();
    g.st.symlinks = null;
    const [r] = await createGitRepoSyncer(c, g.exec, g.fs).syncEach([spec]);
    expect(g.ops()).not.toContain("rev-parse HEAD FETCH_HEAD");
    expect(g.ops()).toContain("read-tree --empty");
    expect(g.ops()).toContain("-c core.symlinks=false reset --hard FETCH_HEAD");
    expect(g.ops()).toContain("config core.symlinks false");
    expect(r).toMatchObject({ status: "synced", resetSkipped: false });
  });
});

// 実 git 統合(§10.1): 「scrub 済み origin でも URL 引数 fetch で default branch 追従でき、
// 未追跡残骸は clean で消え、tracked は温存される」を実 git の意味論で固定する。
describe("createGitRepoSyncer 実 git 統合(scrub + URL 引数 fetch)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const exists = async (p: string): Promise<boolean> =>
    access(p).then(
      () => true,
      () => false,
    );

  it("clone → origin scrub → 残骸投入 → 再 sync で最新化 + 残骸除去", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-repos-"));
    tmpDirs.push(root);
    const originDir = join(root, "origin.git");
    const seedDir = join(root, "seed");
    await execFileAsync("git", ["init", "--bare", "-b", "main", originDir]);
    await execFileAsync("git", ["clone", originDir, seedDir]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.email", "t@example.com"]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.name", "t"]);
    await writeFile(join(seedDir, "tracked.md"), "v1\n");
    await execFileAsync("git", ["-C", seedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", seedDir, "commit", "-m", "c1"]);
    await execFileAsync("git", ["-C", seedDir, "push", "origin", "main"]);

    const clonesDir = join(root, "clones");
    const syncer = createGitRepoSyncer(clonesDir);
    // file:// を使う: プレーンなローカルパスだと --depth=1 が無視され(local clone 最適化)、
    // 本番と同じ shallow clone / shallow fetch 経路を検証できない。
    const spec: RepoSpec = { repo: "org/kb", dir: "kb", url: `file://${originDir}` };

    // 初回 sync = clone + set-url(file:// は stripCredentials で不変だが経路は通る)。
    const [first] = await syncer.sync([spec]);
    const kbDir = join(clonesDir, "kb");
    expect(first?.resolvedCommit).toHaveLength(40);
    // 本番同等の shallow であること(file:// で --depth=1 が実際に効いている)。
    expect(await exists(join(kbDir, ".git", "shallow"))).toBe(true);

    // origin 側を進め、clone 側に未追跡残骸を置く。
    await writeFile(join(seedDir, "tracked.md"), "v1\nv2\n");
    await execFileAsync("git", ["-C", seedDir, "commit", "-am", "c2"]);
    await execFileAsync("git", ["-C", seedDir, "push", "origin", "main"]);
    await writeFile(join(kbDir, "litter.md"), "staging 残骸\n");

    const [second] = await syncer.sync([spec]);
    expect(second?.resolvedCommit).not.toBe(first?.resolvedCommit);
    expect(await exists(join(kbDir, "litter.md"))).toBe(false);
    expect(await exists(join(kbDir, "tracked.md"))).toBe(true);
  });

  /** origin(bare)と seed(push 用)を作る。commit=false なら commit 無しの空リポのまま。 */
  async function makeOrigin(
    root: string,
    commit: boolean,
  ): Promise<{
    url: string;
    seedDir: string;
    push: (file: string, body: string) => Promise<void>;
  }> {
    const originDir = join(root, "origin.git");
    const seedDir = join(root, "seed");
    await execFileAsync("git", ["init", "--bare", "-b", "main", originDir]);
    await execFileAsync("git", ["clone", originDir, seedDir]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.email", "t@example.com"]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.name", "t"]);
    const push = async (file: string, body: string): Promise<void> => {
      await writeFile(join(seedDir, file), body);
      await execFileAsync("git", ["-C", seedDir, "add", "-A"]);
      await execFileAsync("git", ["-C", seedDir, "commit", "-m", file]);
      await execFileAsync("git", ["-C", seedDir, "push", "origin", "main"]);
    };
    if (commit) await push("tracked.md", "v1\n");
    return { url: `file://${originDir}`, seedDir, push };
  }

  // 段階 1-2: TTL 再利用の可否を実 git の意味論で固定する(書き込み・未追跡で汚れ、HEAD は同期で動く)。
  it("inspect: 同期直後はクリーンで HEAD 一致。書き込み・未追跡で汚れ、restoreHead で戻る。同期で HEAD が動く", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-repos-inspect-real-"));
    tmpDirs.push(root);
    const { url, push } = await makeOrigin(root, true);
    const clonesDir = join(root, "clones");
    const syncer = createGitRepoSyncer(clonesDir);
    const spec: RepoSpec = { repo: "org/kb", dir: "kb", url };
    const [first] = await syncer.syncEach([spec]);
    if (first?.status !== "synced") throw new Error("sync failed");
    const recorded = first.synced.resolvedCommit;
    const kbDir = join(clonesDir, "kb");

    expect(await syncer.inspect(spec)).toEqual({ synced: first.synced, clean: true });
    // 鮮度確認の書き込みと同じ「tracked ファイルの変更」は汚れ(TTL で再利用しない)。
    await writeFile(join(kbDir, "tracked.md"), "local edit\n");
    expect((await syncer.inspect(spec))?.clean).toBe(false);
    // 前回データ利用時は HEAD に戻してから検索する(内容と引用 SHA を一致させる)。
    const restored = await syncer.restoreHead(spec);
    expect(restored).toEqual({ synced: first.synced, clean: true });
    expect(await readFile(join(kbDir, "tracked.md"), "utf8")).toBe("v1\n");
    // 未追跡ファイルも汚れとみなす(除外なし)。
    await writeFile(join(kbDir, "litter.md"), "x\n");
    expect((await syncer.inspect(spec))?.clean).toBe(false);
    await syncer.restoreHead(spec);
    expect(await exists(join(kbDir, "litter.md"))).toBe(false);

    // origin が進んで同期されると HEAD は記録 SHA と一致しなくなる(再利用の条件から外れる)。
    await push("next.md", "v2\n");
    await syncer.syncEach([spec]);
    const after = await syncer.inspect(spec);
    expect(after?.clean).toBe(true);
    expect(after?.synced.resolvedCommit).not.toBe(recorded);
  });

  // ADR-0035 追記(2026-10-08): reset/clean の省略を実 git の意味論で固定する。
  it("変化が無くクリーンなら reset/clean を省き、残骸・書き込みがあれば reset/clean で消す", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-repos-skipreset-real-"));
    tmpDirs.push(root);
    const { url, push } = await makeOrigin(root, true);
    const clonesDir = join(root, "clones");
    const syncer = createGitRepoSyncer(clonesDir);
    const spec: RepoSpec = { repo: "org/kb", dir: "kb", url };
    const kbDir = join(clonesDir, "kb");

    const [cloned] = await syncer.syncEach([spec]); // 新規 clone
    if (cloned?.status !== "synced") throw new Error("sync failed");
    expect(cloned.resetSkipped).toBe(false);
    const [same] = await syncer.syncEach([spec]); // fast 経路・remote 不変・クリーン
    expect(same).toMatchObject({ status: "synced", resetSkipped: true, synced: cloned.synced });
    expect(await syncer.inspect(spec)).toEqual({ synced: cloned.synced, clean: true });
    // 再起動直後の最終成功時刻の推定(FETCH_HEAD と HEAD の一致)も成り立つ。
    expect(await syncer.fetchTimeOnDisk(spec)).not.toBeNull();

    // 未追跡の残骸・tracked の書き換えは status で検知し、reset/clean で消す。
    await writeFile(join(kbDir, "litter.md"), "x\n");
    await writeFile(join(kbDir, "tracked.md"), "local edit\n");
    const [dirty] = await syncer.syncEach([spec]);
    expect(dirty).toMatchObject({ status: "synced", resetSkipped: false, synced: cloned.synced });
    expect(await exists(join(kbDir, "litter.md"))).toBe(false);
    expect(await readFile(join(kbDir, "tracked.md"), "utf8")).toBe("v1\n");

    // remote が進めば reset で追従する。
    await push("next.md", "v2\n");
    const [moved] = await syncer.syncEach([spec]);
    expect(moved).toMatchObject({ status: "synced", resetSkipped: false });
    expect(moved?.status === "synced" && moved.synced.resolvedCommit).not.toBe(
      cloned.synced.resolvedCommit,
    );
    expect(await readFile(join(kbDir, "next.md"), "utf8")).toBe("v2\n");
    expect((await syncer.inspect(spec))?.clean).toBe(true);
  });

  // 段階 1-2: 再起動直後の最終成功時刻は、実 git が書く FETCH_HEAD / HEAD の更新時刻から補う。
  it("fetchTimeOnDisk: clone 直後は .git/HEAD の時刻、fetch 後は FETCH_HEAD の時刻(HEAD と SHA 一致)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-repos-fetchtime-real-"));
    tmpDirs.push(root);
    const { url, push } = await makeOrigin(root, true);
    const clonesDir = join(root, "clones");
    const syncer = createGitRepoSyncer(clonesDir);
    const spec: RepoSpec = { repo: "org/kb", dir: "kb", url };
    const gitDir = join(clonesDir, "kb", ".git");

    await syncer.syncEach([spec]); // 新規 clone(FETCH_HEAD は書かれない)
    expect(await exists(join(gitDir, "FETCH_HEAD"))).toBe(false);
    const cloned = await syncer.fetchTimeOnDisk(spec);
    expect(cloned).toBe((await stat(join(gitDir, "HEAD"))).mtimeMs);

    await push("next.md", "v2\n");
    await syncer.syncEach([spec]); // 既存 clone の fetch → reset
    const fetched = await syncer.fetchTimeOnDisk(spec);
    expect(fetched).toBe((await stat(join(gitDir, "FETCH_HEAD"))).mtimeMs);
    expect(Math.abs((fetched ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  // ADR-0037 × ADR-0036: 定期同期・/ask のリポ単位同期(syncEach)で作る clone も symlink を無害化する。
  it("syncEach の新規 clone も core.symlinks=false で展開し、既存(未移行)clone も移行する", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-repos-each-symlink-"));
    tmpDirs.push(root);
    const { url, seedDir } = await makeOrigin(root, true);
    const outside = join(root, "outside-secret.txt");
    await writeFile(outside, "SECRET\n");
    await symlink(outside, join(seedDir, "leak"));
    await execFileAsync("git", ["-C", seedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", seedDir, "commit", "-m", "leak"]);
    await execFileAsync("git", ["-C", seedDir, "push", "origin", "main"]);
    const clonesDir = join(root, "clones");
    const syncer = createGitRepoSyncer(clonesDir);

    const [fresh] = await syncer.syncEach([{ repo: "org/a", dir: "a", url }]);
    expect(fresh?.status).toBe("synced");
    expect((await lstat(join(clonesDir, "a", "leak"))).isSymbolicLink()).toBe(false);
    const cfgA = await execFileAsync("git", [
      "-C",
      join(clonesDir, "a"),
      "config",
      "--get",
      "core.symlinks",
    ]);
    expect(cfgA.stdout.trim()).toBe("false");

    const legacy = join(clonesDir, "b");
    await execFileAsync("git", ["clone", "--depth=1", url, legacy]);
    expect((await lstat(join(legacy, "leak"))).isSymbolicLink()).toBe(true);
    const [migrated] = await syncer.syncEach([{ repo: "org/b", dir: "b", url }]);
    expect(migrated?.status).toBe("synced");
    expect((await lstat(join(legacy, "leak"))).isSymbolicLink()).toBe(false);
    const cfgB = await execFileAsync("git", ["-C", legacy, "config", "--get", "core.symlinks"]);
    expect(cfgB.stdout.trim()).toBe("false");
  });

  // VM 実験(2026-09-30): commit の無い org リポは clone できるが HEAD が無く rev-parse HEAD が失敗する。
  it("空リポは syncEach で empty(失敗にしない)。再同期も empty、commit が入れば synced になる", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-repos-empty-"));
    tmpDirs.push(root);
    const { url, push } = await makeOrigin(root, false);
    const clonesDir = join(root, "clones");
    const syncer = createGitRepoSyncer(clonesDir);
    const spec: RepoSpec = { repo: "org/empty", dir: "empty", url };

    // 新規 clone(空)→ empty。clone 自体は残る(次回は既存 clone 経路)。
    expect((await syncer.syncEach([spec]))[0]?.status).toBe("empty");
    expect(await exists(join(clonesDir, "empty", ".git"))).toBe(true);
    // 既存の空 clone: fetch(remote HEAD 不在で失敗する)をせず empty。
    expect((await syncer.syncEach([spec]))[0]?.status).toBe("empty");
    // resolveHead は null(/ask を壊さない)。
    expect(await syncer.resolveHead(spec)).toBeNull();
    // 従来の sync は空リポを失敗として throw(all_visible 無しの挙動は不変)。
    await expect(syncer.sync([spec])).rejects.toThrow();

    // origin に commit が入れば通常の fetch/reset で展開される。
    await push("first.md", "hello\n");
    const [after] = await syncer.syncEach([spec]);
    expect(after?.status).toBe("synced");
    expect(await readFile(join(clonesDir, "empty", "first.md"), "utf8")).toBe("hello\n");
    expect((await syncer.resolveHead(spec))?.resolvedCommit).toHaveLength(40);
  });

  // ADR-0037: コミットされた cwd 外向き symlink(x -> /data/bot.db 型)を clone 側で無害化する。
  it("新規 clone・既存(未移行)clone のどちらでも symlink は通常ファイル(本文=リンク先パス)になる", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-repos-symlink-"));
    tmpDirs.push(root);
    const originDir = join(root, "origin.git");
    const seedDir = join(root, "seed");
    const outside = join(root, "outside-secret.txt");
    await writeFile(outside, "SECRET\n");
    await execFileAsync("git", ["init", "--bare", "-b", "main", originDir]);
    await execFileAsync("git", ["clone", originDir, seedDir]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.email", "t@example.com"]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.name", "t"]);
    await writeFile(join(seedDir, "tracked.md"), "v1\n");
    await symlink(outside, join(seedDir, "leak"));
    await execFileAsync("git", ["-C", seedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", seedDir, "commit", "-m", "c1"]);
    await execFileAsync("git", ["-C", seedDir, "push", "origin", "main"]);
    const url = `file://${originDir}`;
    const clonesDir = join(root, "clones");

    // (1) 新規 clone: 初回 checkout から通常ファイル。
    await createGitRepoSyncer(clonesDir).sync([{ repo: "org/a", dir: "a", url }]);
    const fresh = join(clonesDir, "a", "leak");
    expect((await lstat(fresh)).isSymbolicLink()).toBe(false);
    expect(await readFile(fresh, "utf8")).toBe(outside);

    // (2) 旧デプロイで symlink 有効のまま clone 済み → sync で移行され通常ファイルに置換される。
    const legacy = join(clonesDir, "b");
    await execFileAsync("git", ["clone", "--depth=1", url, legacy]);
    expect((await lstat(join(legacy, "leak"))).isSymbolicLink()).toBe(true);
    await createGitRepoSyncer(clonesDir).sync([{ repo: "org/b", dir: "b", url }]);
    expect((await lstat(join(legacy, "leak"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(legacy, "leak"), "utf8")).toBe(outside);
    expect(await readFile(join(legacy, "tracked.md"), "utf8")).toBe("v1\n");
    const cfg = await execFileAsync("git", ["-C", legacy, "config", "--get", "core.symlinks"]);
    expect(cfg.stdout.trim()).toBe("false");
    // 作業ツリーは clean のまま(permalink の commit と内容が一致)。
    const st = await execFileAsync("git", ["-C", legacy, "status", "--porcelain"]);
    expect(st.stdout).toBe("");

    // (3) 以後の sync(移行済み)で新たにコミットされた symlink も通常ファイルで展開される。
    await symlink(outside, join(seedDir, "leak2"));
    await execFileAsync("git", ["-C", seedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", seedDir, "commit", "-m", "c2"]);
    await execFileAsync("git", ["-C", seedDir, "push", "origin", "main"]);
    await createGitRepoSyncer(clonesDir).sync([{ repo: "org/b", dir: "b", url }]);
    expect((await lstat(join(legacy, "leak2"))).isSymbolicLink()).toBe(false);
  });
});
