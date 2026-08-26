import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GitExec, stripCredentials, syncKb } from "./kb-sync.js";

const execFileAsync = promisify(execFile);

const TOKEN_URL = "https://x-access-token:SECRET@github.com/org/knowledge-base.git";
const CLEAN_URL = "https://github.com/org/knowledge-base.git";

// syncKb は実 mkdir(clonesDir) を行うため、fake テストでも書き込める実 tmp dir を使う。
let c: string;
beforeEach(async () => {
  c = await mkdtemp(join(tmpdir(), "gap-kbsync-fake-"));
});
afterEach(async () => {
  await rm(c, { recursive: true, force: true });
});

/** exec 記録 fake。existing=false は --git-dir probe を throw(未 clone)、true は独立リポ(".git")。 */
function fakeExec(existing: boolean): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--git-dir") {
      if (!existing) throw new Error("not a repo");
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

describe("syncKb(トークン非永続化・ADR-0013 D1(b) と同流儀)", () => {
  it("新規 clone 後に remote URL をトークン無しへ差し替える", async () => {
    const { exec, calls } = fakeExec(false);
    const r = await syncKb({ dir: "knowledge-base", url: TOKEN_URL, baseBranch: "main" }, c, exec);
    expect(r.resolvedCommit).toBe("abc123");
    expect(calls.some((a) => a[0] === "clone")).toBe(true);
    expect(calls).toContainEqual(["remote", "set-url", "origin", CLEAN_URL]);
  });
  it("既存 clone + url は URL 引数 fetch + FETCH_HEAD reset + 未追跡残骸の clean", async () => {
    const { exec, calls } = fakeExec(true);
    await syncKb({ dir: "knowledge-base", url: TOKEN_URL, baseBranch: "main" }, c, exec);
    expect(calls).toContainEqual(["fetch", TOKEN_URL, "main"]);
    expect(calls).toContainEqual(["reset", "--hard", "FETCH_HEAD"]);
    // reset --hard は未追跡ファイルを消さない。dry-run staging の残骸が冪等スキャンに
    // 誤検知される(queue 消費・VM 実害 2026-07-22)ため、reset 後に clean する。
    const resetIdx = calls.findIndex((a) => a[0] === "reset");
    const cleanIdx = calls.findIndex((a) => a[0] === "clean");
    expect(calls[cleanIdx]).toEqual(["clean", "-fd"]);
    expect(cleanIdx).toBeGreaterThan(resetIdx);
  });
  it("url 無し・clone 未存在は throw", async () => {
    const { exec } = fakeExec(false);
    await expect(syncKb({ dir: "kb", baseBranch: "main" }, c, exec)).rejects.toThrow();
  });
  it("url 無し・既存 dir は fetch/reset/clean せず rev-parse のみ(破壊的 clean を走らせない)", async () => {
    const { exec, calls } = fakeExec(true);
    const r = await syncKb({ dir: "knowledge-base", baseBranch: "main" }, c, exec);
    expect(r.resolvedCommit).toBe("abc123");
    expect(
      calls.some(
        (a) => a[0] === "fetch" || a[0] === "reset" || a[0] === "clean" || a[0] === "clone",
      ),
    ).toBe(false);
  });
  it("親リポの内側(--git-dir が ../.git)は fetch/reset/clone せず throw(親リポ破壊防止)", async () => {
    // --is-inside-work-tree 判定は親リポの内側でも true になり reset --hard が親を破壊した
    // (VM 実害 2026-07-17)。--git-dir が相対 ".git" 以外なら独立リポでないとして fail-loud。
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push([...args]);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { stdout: "../.git\n" };
      return { stdout: "abc123\n" };
    };
    await expect(
      syncKb({ dir: "knowledge-base", url: TOKEN_URL, baseBranch: "main" }, c, exec),
    ).rejects.toThrow(/独立した git リポではありません/);
    expect(
      calls.some(
        (a) => a[0] === "fetch" || a[0] === "reset" || a[0] === "clean" || a[0] === "clone",
      ),
    ).toBe(false);
  });
});

// 実 git で「git コマンドの意味論」を固定する統合テスト(§10.1)。今回の障害は
// 「reset --hard が未追跡ファイルを消す」という誤仮定であり、exec 記録 fake は仮定を
// エンコードするだけで検知できない。実 git でのみ再発を実証できる(VM 実害 2026-07-22)。
describe("syncKb 実 git 統合(未追跡 staging 残骸の掃除)", () => {
  const tmpDirs: string[] = [];
  const realExec: GitExec = async (args, cwd) => execFileAsync("git", [...args], { cwd });
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const exists = async (p: string): Promise<boolean> =>
    access(p).then(
      () => true,
      () => false,
    );

  it("sync 後: 未追跡の staging 残骸は消え、commit 済みファイルは残る", async () => {
    const root = await mkdtemp(join(tmpdir(), "gap-kbsync-"));
    tmpDirs.push(root);
    // origin 役の bare リポに 1 コミット(tracked.md)を用意。
    const originDir = join(root, "origin.git");
    const seedDir = join(root, "seed");
    await execFileAsync("git", ["init", "--bare", "-b", "main", originDir]);
    await execFileAsync("git", ["clone", originDir, seedDir]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.email", "t@example.com"]);
    await execFileAsync("git", ["-C", seedDir, "config", "user.name", "t"]);
    await writeFile(join(seedDir, "tracked.md"), "tracked\n");
    await execFileAsync("git", ["-C", seedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", seedDir, "commit", "-m", "seed"]);
    await execFileAsync("git", ["-C", seedDir, "push", "origin", "main"]);

    // clones 配下に既存 clone を作り、そこへ「未追跡の残骸」を置く(dry-run staging を模す)。
    const clonesDir = join(root, "clones");
    await execFileAsync("git", ["clone", originDir, join(clonesDir, "knowledge-base")]);
    const kbDir = join(clonesDir, "knowledge-base");
    await writeFile(join(kbDir, "q-9999-litter.md"), "dry-run の残骸\n");
    expect(await exists(join(kbDir, "q-9999-litter.md"))).toBe(true);

    await syncKb(
      { dir: "knowledge-base", url: originDir, baseBranch: "main" },
      clonesDir,
      realExec,
    );

    // clean -fd が未追跡残骸を除去し、tracked は温存される。
    expect(await exists(join(kbDir, "q-9999-litter.md"))).toBe(false);
    expect(await exists(join(kbDir, "tracked.md"))).toBe(true);
  });
});
