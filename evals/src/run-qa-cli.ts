/**
 * 週次 golden eval の CLI(design.md §10.2)。`node dist/run-qa-cli.js` で実行する。
 * runGoldenEval を実走 → baseline と比較 → eval-result.json を書き出す。
 * アラート(>10pt 低下 or passCount<8)の判定は `alert` フラグに載せ、Discord 通知は workflow が行う。
 * eval 自体が失敗(API エラー等)したときのみ exit≠0(GitHub の失敗通知に乗せる)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareToBaseline, type EvalScore } from "./baseline.js";
import { runGoldenEval } from "./run-qa.js";

const PROMPTS_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));
const CORPUS_DIR = fileURLToPath(new URL("../fixtures/qa-corpus", import.meta.url));
const GOLDEN = readFileSync(fileURLToPath(new URL("../golden-qa.yaml", import.meta.url)), "utf8");
const BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../baseline.json", import.meta.url)), "utf8"),
) as EvalScore;
const OUT = fileURLToPath(new URL("../eval-result.json", import.meta.url));

const REPOS = [
  { repo: "org/minutes", dir: "minutes" },
  { repo: "org/dispenser-fw", dir: "dispenser-fw" },
  { repo: "org/knowledge-base", dir: "knowledge-base" },
];

async function main(): Promise<void> {
  const { citation, validity } = await runGoldenEval({
    goldenYaml: GOLDEN,
    promptsDir: PROMPTS_DIR,
    corpusDir: CORPUS_DIR,
    repos: REPOS,
  });
  const current: EvalScore = {
    citationMatchRate: citation.citationMatchRate,
    validityRate: validity.validityRate,
  };
  const comparison = compareToBaseline(current, BASELINE);
  const belowFloor = citation.passCount < 8; // §6.2 AC1 の床
  const alert = comparison.regressed || belowFloor;

  const out = {
    generatedAt: new Date().toISOString(),
    current,
    baseline: BASELINE,
    comparison,
    belowFloor,
    alert,
    citation,
    validity,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ current, comparison, belowFloor, alert }, null, 2));
  if (alert) {
    const dropped =
      comparison.drops.map((d) => `${d.metric}-${d.delta.toFixed(2)}`).join(",") || "none";
    console.log(
      `ALERT: golden eval regression/floor (passCount=${citation.passCount}, drops=${dropped})`,
    );
  }
}

main().catch((err) => {
  console.error("eval failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
