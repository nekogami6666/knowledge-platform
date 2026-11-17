/**
 * 週次 golden eval の CLI(design.md §10.2)。`node dist/run-qa-cli.js` で実行する。
 * runGoldenEval を実走 → baseline と比較 → eval-result.json を書き出す。
 * アラート(>10pt 低下 or 出典一致率 <0.8)の判定は `alert` フラグに載せ、Discord 通知は workflow が行う。
 * eval 自体が失敗(API エラー等)したときのみ exit≠0(GitHub の失敗通知に乗せる)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareToBaseline, type EvalScore } from "./baseline.js";
import { runGoldenEval } from "./run-qa.js";
import { listMisses } from "./score.js";

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
  const { citation, validity, results } = await runGoldenEval({
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
  // 外れた問題と引用先(synthetic コーパスなので出してよい・ADR-0002)。原因を週次ログ・通知から追えるように。
  const misses = listMisses(citation, results);
  // §6.2 AC1 の床。**率**で判定する(旧実装は `passCount < 8` の絶対数で、golden を 10 件から
  // 増やした瞬間に床が実質無効化する時限バグだった — 50 件なら「正答 16% 未満」まで鳴らない)。
  const belowFloor = citation.citationMatchRate < 0.8;
  const alert = comparison.regressed || belowFloor;

  // ADR-0035 D6: 所要時間・ターン数(正答率は非退行の門番、速度は参考値。速度の受け入れは VM 実測)。
  const timing = results.map((r) => ({
    id: r.id,
    elapsedMs: r.elapsedMs ?? null,
    numTurns: r.numTurns ?? null,
  }));
  const elapsed = results.map((r) => r.elapsedMs ?? 0);
  const timingSummary = {
    avgElapsedMs:
      elapsed.length === 0 ? 0 : Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length),
    maxElapsedMs: elapsed.length === 0 ? 0 : Math.max(...elapsed),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    current,
    baseline: BASELINE,
    comparison,
    belowFloor,
    alert,
    directMatchRate: citation.directMatchRate,
    misses,
    citation,
    validity,
    timingSummary,
    timing,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      {
        current,
        directMatchRate: citation.directMatchRate,
        comparison,
        belowFloor,
        alert,
        misses,
        timingSummary,
      },
      null,
      2,
    ),
  );
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
