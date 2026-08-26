/**
 * 検索対象リポのローカル同期(design.md §6.2)。
 * 起動時に shallow clone、以後 `git fetch <url> && reset --hard && clean -fd` で最新化し、回答時点の
 * commit SHA(resolvedCommit)を返す。permalink はこの SHA を ref に使う(branch だと後から内容がズレるため)。
 *
 * 認証(ADR-0013 D1(b) / §9.1): url にトークンが含まれても **.git/config に永続化しない**。
 * origin は毎 sync で冪等にトークン無し URL へ上書きし(過去の clone・手動配置の残留も自己修復)、
 * fetch は url を引数で渡す(origin 参照しない)。
 * → 残留トークンが agentic search の読み取り面(cwd 配下の .git/config)に載るのを防ぐ。
 * scrub はバッチ側(gap-tracker/freshness/extractor)と同流儀。**fetch 対象の選び方は異なる**:
 * bot は refspec 無し(remote HEAD = default branch 追従)、バッチは baseBranch 固定。共有クローンや
 * 将来の共有パッケージ統合(§2 方針・stripCredentials は 4 複製目)では差異に注意。
 *
 * `RepoSyncer` は注入可能な seam。テストは fake の git を渡し、本番は既定の execFile を使う
 * (CLAUDE.md §12.2: native/外部プロセス依存のグルーは統合テストで代替)。
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** git 実行の最小 seam(注入でモック可能)。args は `git` に続く引数列。 */
export type GitExec = (args: readonly string[]) => Promise<{ stdout: string }>;

const defaultGitExec: GitExec = (args) => exec("git", [...args]);

/** https URL から userinfo(user:token@)を除去する(トークンを .git/config に残さない)。 */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

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
 * - ディレクトリが無く url がある: `git clone --depth=1 <url>` → `git remote set-url origin <scrubbed>`
 * - 既存: `git fetch --depth=1 <url>`(default branch)→ `git reset --hard FETCH_HEAD` → `git clean -fd`
 * 最後に `git rev-parse HEAD` で resolvedCommit を得る。fetch は url を引数で渡すため、origin に
 * トークンを残さずに private リポを更新できる(scrub 後も fetch が通る・VM 実証 2026-07-22)。
 * git 実行は注入 seam(既定は実 execFile)。
 */
export function createGitRepoSyncer(
  clonesDir: string,
  gitExec: GitExec = defaultGitExec,
): RepoSyncer {
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
          gitDir = (await gitExec(["-C", absDir, "rev-parse", "--git-dir"])).stdout.trim();
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
            // 冪等 scrub: 旧デプロイの clone や set-url 前クラッシュで origin にトークンが
            // 残っていても、毎 sync で無害化する(remote 不在でも通る config 書き)。
            await gitExec([
              "-C",
              absDir,
              "config",
              "remote.origin.url",
              stripCredentials(spec.url),
            ]);
            // url を引数で渡す(origin の保存 URL に依存しない=トークンを config に残さない)。
            // refspec 無しの fetch は remote HEAD(= default branch)を FETCH_HEAD に置く。
            await gitExec(["-C", absDir, "fetch", "--depth=1", spec.url]);
            await gitExec(["-C", absDir, "reset", "--hard", "FETCH_HEAD"]);
            // reset --hard は未追跡ファイルを消さない。他プロセス(gap-tracker 等)の staging
            // 残骸が検索対象に混入し、未 commit ファイルへの permalink を生成しうるため clean する。
            await gitExec(["-C", absDir, "clean", "-fd"]);
          } else {
            await gitExec(["clone", "--depth=1", spec.url, absDir]);
            // clone は origin にトークン含み URL を書くため、即座にトークン無しへ差し替える(ADR-0013)。
            await gitExec([
              "-C",
              absDir,
              "remote",
              "set-url",
              "origin",
              stripCredentials(spec.url),
            ]);
          }
        }
        const { stdout } = await gitExec(["-C", absDir, "rev-parse", "HEAD"]);
        out.push({ repo: spec.repo, absDir, resolvedCommit: stdout.trim() });
      }
      return out;
    },
  };
}
