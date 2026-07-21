/**
 * knowledge-base clone の同期(1 リポ版)。extractor/src/repos.ts・gap-tracker/src/kb-sync.ts と
 * 同じ流儀: トークンを .git/config に永続化しない(clone 後 set-url scrub・fetch は URL 引数・
 * ADR-0013 D1(b))。これで 3 つ目の consumer になったため共有パッケージへの統合が必要 —
 * 独立 PR で行う(この PR では複製で進める・§2-F 方針)。
 */
import { join } from "node:path";

export type GitExec = (args: readonly string[], cwd: string) => Promise<{ stdout: string }>;

/** https URL から userinfo(user:token@)を除去する。 */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

export interface SyncedKb {
  absDir: string;
  resolvedCommit: string;
}

export async function syncKb(
  opts: { dir: string; url?: string; baseBranch: string },
  clonesDir: string,
  exec: GitExec,
): Promise<SyncedKb> {
  const absDir = join(clonesDir, opts.dir);
  // 対象 dir が「自身が toplevel の独立リポ」か(cwd が toplevel のときだけ --git-dir は相対 ".git")。
  // --is-inside-work-tree は親リポの内側でも true になり、fetch + reset --hard が親リポ全体を
  // KB 内容で破壊する(VM 実害 2026-07-17)。probe 失敗(dir 不存在・リポ外)は clone パスへ。
  let gitDir: string | null;
  try {
    gitDir = (await exec(["rev-parse", "--git-dir"], absDir)).stdout.trim();
  } catch {
    gitDir = null;
  }
  if (gitDir !== null && gitDir !== ".git") {
    // 親リポの内側。url 無しでも rev-parse HEAD が親の commit を返す(provenance 汚染)ため fail-loud。
    throw new Error(
      `${absDir} は独立した git リポではありません(--git-dir: ${gitDir})。clones 配下は各ディレクトリを独立リポとして配置してください`,
    );
  }
  if (gitDir !== null) {
    if (opts.url !== undefined) {
      await exec(["fetch", opts.url, opts.baseBranch], absDir);
      await exec(["reset", "--hard", "FETCH_HEAD"], absDir);
    }
  } else {
    if (opts.url === undefined) {
      throw new Error(`clone 先が存在せず url も未指定です: ${opts.dir}`);
    }
    await exec(["clone", opts.url, opts.dir], clonesDir);
    await exec(["remote", "set-url", "origin", stripCredentials(opts.url)], absDir);
  }
  const { stdout } = await exec(["rev-parse", "HEAD"], absDir);
  return { absDir, resolvedCommit: stdout.trim() };
}
