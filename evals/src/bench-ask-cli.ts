/**
 * /ask の速度ベンチの CLI(`pnpm --filter @stratum/evals bench:ask`)。golden の先頭 N 問
 * (env BENCH_N・既定 6・上限は golden の件数)を本番と同じ QA パイプラインで synthetic コーパスに流し、
 * 1 問ごとの行と集計(平均・中央値・最大)を JSON で標準出力に出す。
 *
 * 実 Claude(Claude on AWS)を使う: `ANTHROPIC_AWS_API_KEY` が無ければ何もせず終わる(CI・テストでは走らない)。
 * 呼び出し側が CLAUDE_CODE_USE_ANTHROPIC_AWS / ANTHROPIC_AWS_* / AWS_REGION を用意する(ADR-0009)。
 * 質問本文・回答本文は出さない(id と数値だけ)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createQaSearch } from "@stratum/discord-bot/qa";
import { createFsPromptStore } from "@stratum/llm";
import { runAskBench, summarizeBench } from "./bench-ask.js";
import { loadGoldenQa } from "./golden.js";
import { loadQaSystemPrompt } from "./run-qa.js";

const PROMPTS_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));
const CORPUS_DIR = fileURLToPath(new URL("../fixtures/qa-corpus", import.meta.url));
const GOLDEN = readFileSync(fileURLToPath(new URL("../golden-qa.yaml", import.meta.url)), "utf8");

// corpus の subdir ↔ repo(org/name)対応(run-qa-cli.ts と同じ)。
const REPOS = [
  { repo: "org/minutes", dir: "minutes" },
  { repo: "org/dispenser-fw", dir: "dispenser-fw" },
  { repo: "org/knowledge-base", dir: "knowledge-base" },
];

const DEFAULT_N = 6;

/** BENCH_N を正の整数として読む(不正・未指定は既定値)。 */
function benchN(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_N;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_AWS_API_KEY) {
    console.log("ANTHROPIC_AWS_API_KEY が無いためベンチを実行しません(実 Claude を使うため)。");
    return;
  }
  const golden = loadGoldenQa(GOLDEN);
  const limit = Math.min(benchN(process.env.BENCH_N), golden.length);
  const systemPrompt = await loadQaSystemPrompt(createFsPromptStore(PROMPTS_DIR), REPOS);
  const rows = await runAskBench(
    { golden, limit, systemPrompt, corpusDir: CORPUS_DIR },
    { search: createQaSearch(), onRow: (row) => console.log(JSON.stringify(row)) },
  );
  console.log(JSON.stringify({ summary: summarizeBench(rows) }, null, 2));
}

main().catch((err) => {
  console.error("bench failed:", err instanceof Error ? err.name : String(err));
  process.exitCode = 1;
});
