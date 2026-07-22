/**
 * 検索対象リポのローカル同期(design.md §6.2)。
 * 起動時に shallow clone、以後 `git fetch && reset --hard && clean -fd` で最新化し、回答時点の commit SHA
 * (resolvedCommit)を返す。permalink はこの SHA を ref に使う(branch だと後から内容がズレるため)。
 *
 * `RepoSyncer` は注入可能な seam。テストは fake を渡し、本番は createGitRepoSyncer を使う
 * (CLAUDE.md §12.2: native/外部プロセス依存のグルーは統合テストで代替)。
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** 同期対象リポの宣言。 */
export interface RepoSpec {
  /** "org/name"。citation の allowlist 兼 permalink 用の正規名。 */
  repo: string;
  /** clonesDir 配下の clone 先ディレクトリ名。 */
  dir: string;
  /** git remote URL(clone/fetch 用)。synthetic で既存ディレクトリを使う場合は省略可。 */
  url?: string;
}

/** 同期後の1リポの状態。 */
export interface SyncedRepo {
  repo: string;
  /** clone の絶対パス(citation のファイル存在確認に使う)。 */
  absDir: string;
  /** 同期後の解決済み commit SHA(permalink の ref)。 */
  resolvedCommit: string;
}

export interface RepoSyncer {
  /** 各 repo を最新化し、resolvedCommit を解決して返す。 */
  sync(specs: readonly RepoSpec[]): Promise<SyncedRepo[]>;
}

/**
 * git による RepoSyncer。clonesDir 配下に各 repo を配置する。
 * - ディレクトリが無く url がある: `git clone --depth=1`
 * - 既存: `git fetch --depth=1 origin` → `git reset --hard FETCH_HEAD` → `git clean -fd`
 * 最後に `git rev-parse HEAD` で resolvedCommit を得る。
 */
export function createGitRepoSyncer(clonesDir: string): RepoSyncer {
  return {
    async sync(specs) {
      await mkdir(clonesDir, { recursive: true });
      const out: SyncedRepo[] = [];
      for (const spec of specs) {
        const absDir = join(clonesDir, spec.dir);
        // 対象 dir が「自身が toplevel の独立リポ」か(cwd が toplevel のときだけ --git-dir は
        // 相対 ".git")。成功のみの判定だと親リポの内側でも通ってしまい、fetch + reset --hard が
        // 親リポ全体を破壊する(VM 実害 2026-07-17)。probe 失敗(dir 不存在・リポ外)は clone へ。
        let gitDir: string | null;
        try {
          gitDir = (await exec("git", ["-C", absDir, "rev-parse", "--git-dir"])).stdout.trim();
        } catch {
          gitDir = null;
        }
        if (gitDir !== null && gitDir !== ".git") {
          // 親リポの内側。rev-parse HEAD も親の commit を返す(permalink 汚染)ため fail-loud。
          throw new Error(
            `${absDir} は独立した git リポではありません(--git-dir: ${gitDir})。clones 配下は各ディレクトリを独立リポとして配置してください`,
          );
        }
        if (spec.url !== undefined) {
          // 既存なら fetch/reset、無ければ clone。冪等(§7.1)。
          if (gitDir !== null) {
            await exec("git", ["-C", absDir, "fetch", "--depth=1", "origin"]);
            await exec("git", ["-C", absDir, "reset", "--hard", "FETCH_HEAD"]);
            // reset --hard は未追跡ファイルを消さない。他プロセス(gap-tracker 等)の staging
            // 残骸が検索対象に混入し、未 commit ファイルへの permalink を生成しうるため clean する。
            await exec("git", ["-C", absDir, "clean", "-fd"]);
          } else {
            await exec("git", ["clone", "--depth=1", spec.url, absDir]);
          }
        }
        const { stdout } = await exec("git", ["-C", absDir, "rev-parse", "HEAD"]);
        out.push({ repo: spec.repo, absDir, resolvedCommit: stdout.trim() });
      }
      return out;
    },
  };
}
