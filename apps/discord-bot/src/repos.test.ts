import { execFile } from "node:child_process";
import { access, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepoSyncer, type GitExec, type RepoSpec, stripCredentials } from "./repos.js";

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
