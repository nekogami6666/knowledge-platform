/**
 * 抽出ソースの変更ファイル列挙(design.md §6.3 step1)。git 実行は注入 seam(テスト容易)。
 * 初回(sinceSha=null)は pathspec に合う全ファイル、以降は last_processed_sha..HEAD の差分(追加/変更)。
 * minutes は basename 除外(既定 transcript.md)、interviews はディレクトリ除外
 * (kits/ = 質問リスト・voice-memos/ = capture 経路の原本。どちらも抽出対象外・PR-I1)を使う。
 * ⚠️ 差分には sinceSha までの履歴が必要(nightly workflow は fetch-depth:0 で clone・D11)。
 */
import { basename } from "node:path";

export type GitExec = (args: readonly string[], cwd: string) => Promise<{ stdout: string }>;

function toPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ChangedFilesOptions {
  /** git pathspec(例 "*.md" / "interviews/*.md"。git の `*` は `/` をまたいで一致する)。 */
  pathspec: string;
  /** 除外 basename(例 transcript.md。生書き起こしは重く冗長)。 */
  excludeBasenames?: readonly string[];
  /** 除外ディレクトリ(repo 相対の接頭辞。例 "interviews/kits")。 */
  excludeDirs?: readonly string[];
}

export async function changedSourceFiles(
  root: string,
  sinceSha: string | null,
  headSha: string,
  exec: GitExec,
  opts: ChangedFilesOptions,
): Promise<string[]> {
  const excludedNames = new Set(opts.excludeBasenames ?? []);
  const excludedDirs = (opts.excludeDirs ?? []).map((d) => (d.endsWith("/") ? d : `${d}/`));
  const keep = (p: string): boolean =>
    !excludedNames.has(basename(p)) && !excludedDirs.some((d) => p.startsWith(d));
  if (sinceSha === null) {
    const { stdout } = await exec(["ls-files", opts.pathspec], root);
    return toPaths(stdout).filter(keep);
  }
  const { stdout } = await exec(
    ["diff", "--name-only", "--diff-filter=AM", `${sinceSha}..${headSha}`, "--", opts.pathspec],
    root,
  );
  return toPaths(stdout).filter(keep);
}
