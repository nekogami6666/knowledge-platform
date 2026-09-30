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
 * symlink の無害化(ADR-0037 多層防御): clone は `-c core.symlinks=false` で行い、既存 clone も同設定へ
 * 移行する。git は symlink を「リンク先パスを本文に持つ通常ファイル」として展開するため、検索対象リポに
 * コミットされた `x -> /data/bot.db` 型の symlink が agent の読み取り面で外部へ解決されない
 * (本丸の封じ込めは packages/llm の realpath ガード。ここは clone 側のもう一層)。
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

/**
 * git 1 コマンドの上限(ADR-0035 D3)。ネットワーク停滞で fetch/clone が無限に待つと /ask の
 * interaction token(15 分)が先に失効する。cold な --depth=1 fetch でも十分な 60 秒。
 */
export const GIT_EXEC_TIMEOUT_MS = 60_000;

const defaultGitExec: GitExec = (args) => exec("git", [...args], { timeout: GIT_EXEC_TIMEOUT_MS });

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
  /**
   * リポの説明(GitHub の description 等・任意)。/ask の manifest に載せ、モデルが探索する
   * リポを絞る手がかりにする(ADR-0036 D6)。種別(KB/議事録/コード)は持たせず、説明と名前から
   * モデルに判断させる(リポ名・種別の対応をコードにハードコードしない)。
   */
  description?: string;
}

/** 同期後の1リポの状態。 */
export interface SyncedRepo {
  repo: string;
  /** clone の絶対パス(citation のファイル存在確認に使う)。 */
  absDir: string;
  /** 同期後の解決済み commit SHA(permalink の ref)。 */
  resolvedCommit: string;
}

/**
 * 1 リポ分の同期結果(syncEach。失敗はリポ単位で返し、他のリポを止めない・ADR-0036 D5)。
 * empty = clone はできたが commit が無い空リポ(GitHub で作っただけのリポ等)。失敗ではない。
 */
export type RepoSyncResult =
  | { status: "synced"; spec: RepoSpec; synced: SyncedRepo }
  | { status: "empty"; spec: RepoSpec }
  | { status: "failed"; spec: RepoSpec; error: unknown };

export interface RepoSyncer {
  /** 各 repo を最新化し、resolvedCommit を解決して返す。1 リポでも失敗したら throw(従来挙動)。 */
  sync(specs: readonly RepoSpec[]): Promise<SyncedRepo[]>;
  /**
   * 各 repo を最新化し、リポ単位の結果を specs と同順で返す(throw しない・ADR-0036 D5)。
   * 1 リポの失敗で後続を止めない。空リポは status "empty"(警告対象にしない)。
   * all_visible 有効時の /ask と定期同期が使う。
   */
  syncEach(specs: readonly RepoSpec[]): Promise<RepoSyncResult[]>;
  /**
   * 既存 clone の HEAD を fetch せずに返す(引用の allowlist 用・ADR-0036 D5)。clone が無い・
   * 独立リポでない(親リポの内側)・commit が無い(空リポ)場合は null。
   */
  resolveHead(spec: RepoSpec): Promise<SyncedRepo | null>;
}

/**
 * git による RepoSyncer。clonesDir 配下に各 repo を配置する。
 * - ディレクトリが無く url がある: `git clone --depth=1 <url>` → `git remote set-url origin <scrubbed>`
 * - 既存: `git fetch --depth=1 <url>`(default branch)→ `git reset --hard FETCH_HEAD` → `git clean -fd`
 *   (reset は常に `-c core.symlinks=false`。未移行 clone は reset 前に index を空にして全ファイルを
 *   書き直させ、展開済みの symlink も通常ファイルへ置換してから core.symlinks=false を永続化する)
 * 最後に `git rev-parse HEAD` で resolvedCommit を得る。fetch は url を引数で渡すため、origin に
 * トークンを残さずに private リポを更新できる(scrub 後も fetch が通る・VM 実証 2026-07-22)。
 * git 実行は注入 seam(既定は実 execFile)。
 *
 * 空リポ(syncEach のみ・ADR-0036): commit の無いリポは clone できるが HEAD が無く、既存 clone の
 * fetch は「remote ref HEAD が無い」で失敗する。syncEach では clone 後・fetch 前に HEAD の有無を見て
 * "empty" を返す(既存 clone は `ls-remote <url> HEAD` が空なら fetch しない)。sync は従来どおり
 * (空リポは失敗として throw・コマンド列も不変)。
 */
export function createGitRepoSyncer(
  clonesDir: string,
  gitExec: GitExec = defaultGitExec,
): RepoSyncer {
  /**
   * 対象 dir が「自身が toplevel の独立リポ」か(cwd が toplevel のときだけ --git-dir は
   * 相対 ".git")。成功のみの判定だと親リポの内側でも通ってしまい、fetch + reset --hard が
   * 親リポ全体を破壊する(VM 実害 2026-07-17)。probe 失敗(dir 不存在・リポ外)は null。
   */
  async function probeGitDir(absDir: string): Promise<string | null> {
    try {
      return (await gitExec(["-C", absDir, "rev-parse", "--git-dir"])).stdout.trim();
    } catch {
      return null;
    }
  }

  /** ローカルに commit(HEAD)があるか。空リポの clone は false(`--verify -q` は exit 1)。 */
  async function hasHead(absDir: string): Promise<boolean> {
    try {
      await gitExec(["-C", absDir, "rev-parse", "--verify", "-q", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** 1 リポを同期する。allowEmpty(syncEach)のときだけ空リポを "empty" として返す。 */
  async function syncOne(spec: RepoSpec, allowEmpty: boolean): Promise<SyncedRepo | "empty"> {
    const absDir = join(clonesDir, spec.dir);
    const gitDir = await probeGitDir(absDir);
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
        await gitExec(["-C", absDir, "config", "remote.origin.url", stripCredentials(spec.url)]);
        // 空リポの clone: remote もまだ空なら fetch しない(fetch は remote HEAD 不在で失敗する)。
        // remote に commit が入っていれば通常の fetch/reset に進む(空 clone からの初回展開)。
        if (allowEmpty && !(await hasHead(absDir))) {
          const remote = await gitExec(["ls-remote", spec.url, "HEAD"]);
          if (remote.stdout.trim() === "") return "empty";
        }
        // ADR-0037: core.symlinks=false へ移行済みの clone か(未設定は exit 1 で throw)。
        let symlinksDisabled: boolean;
        try {
          const v = await gitExec(["-C", absDir, "config", "--get", "core.symlinks"]);
          symlinksDisabled = v.stdout.trim() === "false";
        } catch {
          symlinksDisabled = false;
        }
        // url を引数で渡す(origin の保存 URL に依存しない=トークンを config に残さない)。
        // refspec 無しの fetch は remote HEAD(= default branch)を FETCH_HEAD に置く。
        await gitExec(["-C", absDir, "fetch", "--depth=1", spec.url]);
        if (!symlinksDisabled) {
          // 展開済みの symlink は stat 一致のため reset では書き直されない。index を空にして
          // reset --hard に全ファイルを再展開させる(移行時の 1 回だけ)。
          await gitExec(["-C", absDir, "read-tree", "--empty"]);
        }
        await gitExec(["-C", absDir, "-c", "core.symlinks=false", "reset", "--hard", "FETCH_HEAD"]);
        // reset --hard は未追跡ファイルを消さない。他プロセス(gap-tracker 等)の staging
        // 残骸が検索対象に混入し、未 commit ファイルへの permalink を生成しうるため clean する。
        await gitExec(["-C", absDir, "clean", "-fd"]);
        // 再展開が成功してから永続化する(途中失敗なら次回 sync で移行をやり直す)。
        if (!symlinksDisabled) {
          await gitExec(["-C", absDir, "config", "core.symlinks", "false"]);
        }
      } else {
        // -c はクローン先の .git/config に永続化され、初回 checkout から symlink を通常ファイル化する。
        await gitExec(["clone", "-c", "core.symlinks=false", "--depth=1", spec.url, absDir]);
        // clone は origin にトークン含み URL を書くため、即座にトークン無しへ差し替える(ADR-0013)。
        await gitExec(["-C", absDir, "remote", "set-url", "origin", stripCredentials(spec.url)]);
        // clone が成功して HEAD が無い = 空リポ(clone 自体は警告のみで成功する)。
        if (allowEmpty && !(await hasHead(absDir))) return "empty";
      }
    }
    const { stdout } = await gitExec(["-C", absDir, "rev-parse", "HEAD"]);
    return { repo: spec.repo, absDir, resolvedCommit: stdout.trim() };
  }

  return {
    async sync(specs) {
      await mkdir(clonesDir, { recursive: true });
      const out: SyncedRepo[] = [];
      for (const spec of specs) {
        const r = await syncOne(spec, false);
        // allowEmpty=false では "empty" は返らない(空リポは rev-parse HEAD が throw する)。
        if (r !== "empty") out.push(r);
      }
      return out;
    },
    async syncEach(specs) {
      await mkdir(clonesDir, { recursive: true });
      const out: RepoSyncResult[] = [];
      for (const spec of specs) {
        try {
          const r = await syncOne(spec, true);
          out.push(
            r === "empty" ? { status: "empty", spec } : { status: "synced", spec, synced: r },
          );
        } catch (error) {
          out.push({ status: "failed", spec, error });
        }
      }
      return out;
    },
    async resolveHead(spec) {
      const absDir = join(clonesDir, spec.dir);
      if ((await probeGitDir(absDir)) !== ".git") return null;
      try {
        const { stdout } = await gitExec(["-C", absDir, "rev-parse", "HEAD"]);
        return { repo: spec.repo, absDir, resolvedCommit: stdout.trim() };
      } catch {
        return null; // commit の無い clone(空リポ・clone 途中のクラッシュ等)
      }
    },
  };
}
