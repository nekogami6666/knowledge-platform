#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { validateRepo } from "./validate-repo.js";

/**
 * `kb-validate <repo-root> [--json]` — knowledge-base のスキーマ検証 CLI。
 * 不正があれば exit 1(CI / pre-merge ゲート用)。
 */
export interface CliResult {
  code: number;
  out: string;
  err: string;
}

export async function runCli(args: string[]): Promise<CliResult> {
  const json = args.includes("--json");
  const repoRoot = args.find((a) => !a.startsWith("--"));

  if (repoRoot === undefined) {
    return { code: 2, out: "", err: "usage: kb-validate <repo-root> [--json]\n" };
  }

  const report = await validateRepo(repoRoot);

  let out: string;
  if (json) {
    out = `${JSON.stringify(report, null, 2)}\n`;
  } else if (report.ok) {
    out = `OK: ${report.checkedFiles} ファイルを検証、問題なし\n`;
  } else {
    out = `NG: ${report.checkedFiles} ファイル中 ${report.problems.length} 件に問題\n`;
    for (const problem of report.problems) {
      for (const issue of problem.issues) {
        out += `  ${problem.file}: [${issue.path}] ${issue.message}\n`;
      }
    }
  }

  return { code: report.ok ? 0 : 1, out, err: "" };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli(process.argv.slice(2))
    .then((result) => {
      if (result.out) process.stdout.write(result.out);
      if (result.err) process.stderr.write(result.err);
      process.exitCode = result.code;
    })
    .catch((error) => {
      process.stderr.write(`kb-validate でエラー: ${(error as Error).message}\n`);
      process.exitCode = 2;
    });
}
