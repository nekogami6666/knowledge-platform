/**
 * minutes リポジトリの変更ファイル列挙(design.md §6.3 step1)。git 実行は注入 seam(テスト容易)。
 * 初回(sinceSha=null)は全 *.md を対象、以降は last_processed_sha..HEAD の差分(追加/変更)。
 * `exclude` の basename(既定 config の transcript.md)は対象から外す(生書き起こしは重く冗長)。
 * ⚠️ 差分には sinceSha までの履歴が必要(nightly workflow は minutes を fetch-depth:0 で clone・D11)。
 */
import { basename } from "node:path";

export type GitExec = (args: readonly string[], cwd: string) => Promise<{ stdout: string }>;

function toPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function changedMinutesFiles(
  minutesRoot: string,
  sinceSha: string | null,
  headSha: string,
  exec: GitExec,
  exclude: readonly string[] = [],
): Promise<string[]> {
  const excluded = new Set(exclude);
  const keep = (p: string): boolean => !excluded.has(basename(p));
  if (sinceSha === null) {
    const { stdout } = await exec(["ls-files", "*.md"], minutesRoot);
    return toPaths(stdout).filter(keep);
  }
  const { stdout } = await exec(
    ["diff", "--name-only", "--diff-filter=AM", `${sinceSha}..${headSha}`, "--", "*.md"],
    minutesRoot,
  );
  return toPaths(stdout).filter(keep);
}
