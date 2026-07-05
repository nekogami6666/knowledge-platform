/**
 * 抽出品質レビューの CLI(design.md §10.3 / §6.3 受け入れ条件)。手動実行のリリースゲート。
 *
 *   generate: 議事録ディレクトリから最新 N 件(既定 10)を抽出し、レビュー表 YAML を .review/ へ出力
 *   score   : 人間がマークした .review/*.yaml を集計し precision を表示(< 0.80 か未記入ありで exit 1)
 *
 * 抽出は extractFromMinutes(allowedTools:[]・ツール無し単発)のみ = ADR-0012 D1 の安全経路
 * (agentic Read を使わない)。reconcile は回さない。出力は実議事録の内容を含むため
 * evals/.review/ は gitignore(コミット禁止・ADR-0012 D2(a): 結果を外部へ出さない)。
 *
 *   node dist/run-extract-review-cli.js generate --minutes-dir <path> [--kb-root <path>] [--limit 10]
 *   node dist/run-extract-review-cli.js score
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionResult } from "@stratum/extractor/candidate";
import { mapWithLimit } from "@stratum/extractor/concurrency";
import { listDomains } from "@stratum/extractor/domains";
import { extractFromMinutes } from "@stratum/extractor/extract";
import { createFsPromptStore } from "@stratum/llm";
import {
  buildReviewSheet,
  parseReviewSheet,
  scoreReview,
  selectLatestMinutes,
  serializeReviewSheet,
} from "./extract-review.js";

const PROMPTS_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));
const REVIEW_DIR = fileURLToPath(new URL("../.review", import.meta.url));
/** 抽出の並列上限(extract はツール無し単発。レート枠に対し控えめな 3)。 */
const CONCURRENCY = 3;
const DEFAULT_LIMIT = 10;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** dir 以下の全ファイルの相対パスを列挙(同期・小規模前提)。 */
function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue; // .git 等は辿らない
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, root));
    else out.push(relative(root, abs));
  }
  return out;
}

async function generate(): Promise<void> {
  const minutesDir = argValue("minutes-dir");
  if (minutesDir === undefined) {
    console.error("usage: generate --minutes-dir <path> [--kb-root <path>] [--limit N]");
    process.exitCode = 1;
    return;
  }
  const kbRoot = argValue("kb-root");
  const limit = Number(argValue("limit") ?? DEFAULT_LIMIT);
  const targets = selectLatestMinutes(walk(minutesDir), limit);
  if (targets.length === 0) {
    console.error(`対象の議事録が見つかりません: ${minutesDir}`);
    process.exitCode = 1;
    return;
  }
  const existingDomains = kbRoot
    ? await listDomains(kbRoot, (d) => Promise.resolve(readdirSync(d, { withFileTypes: true })))
    : [];
  const promptStore = createFsPromptStore(PROMPTS_DIR);
  mkdirSync(REVIEW_DIR, { recursive: true });

  console.log(
    `対象 ${targets.length} 件(並列 ${CONCURRENCY})。existingDomains=${existingDomains.join(",") || "(なし)"}`,
  );
  await mapWithLimit(targets, CONCURRENCY, async (rel, i) => {
    const content = readFileSync(join(minutesDir, rel), "utf8");
    const started = Date.now();
    let extraction: ExtractionResult;
    try {
      ({ value: extraction } = await extractFromMinutes(
        { repo: "review/minutes", path: rel, content, cwd: minutesDir },
        { promptStore, existingDomains },
      ));
    } catch (e) {
      console.error(
        `[${i + 1}/${targets.length}] 失敗 ${rel}: ${e instanceof Error ? e.message : e}`,
      );
      process.exitCode = 1;
      return null;
    }
    const sheet = buildReviewSheet(rel, extraction, new Date().toISOString());
    const outFile = join(REVIEW_DIR, `${rel.replaceAll("/", "__")}.yaml`);
    writeFileSync(outFile, serializeReviewSheet(sheet));
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(
      `[${i + 1}/${targets.length}] ${rel} → 項目 ${sheet.items.length}(d=${extraction.decisions.length} l=${extraction.learnings.length} q=${extraction.openQuestions.length})${secs}s`,
    );
    return null;
  });
  console.log(
    `\nレビュー表を ${REVIEW_DIR} に出力しました。各項目の verdict に ok/ng を記入後、score を実行してください。`,
  );
}

function score(): void {
  const dir = argValue("dir") ?? REVIEW_DIR;
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  if (files.length === 0) {
    console.error(`レビュー表がありません: ${dir}(先に generate を実行)`);
    process.exitCode = 1;
    return;
  }
  const sheets = files.map((f) => parseReviewSheet(readFileSync(join(dir, f), "utf8")));
  const result = scoreReview(sheets);
  console.log(JSON.stringify({ sheets: files.length, ...result }, null, 2));
  if (result.unmarked > 0) {
    console.log(`未記入 ${result.unmarked} 件があります。全項目に ok/ng を記入してください。`);
  }
  console.log(
    result.pass
      ? `PASS: precision ${result.precision?.toFixed(3)} >= 0.80(§6.3 受け入れ条件)`
      : `FAIL: precision ${result.precision?.toFixed(3) ?? "判定不能"}(§6.3 は 0.80 以上 + 全件判定済みが条件)`,
  );
  if (!result.pass) process.exitCode = 1;
}

const mode = process.argv[2];
if (mode === "generate") {
  generate().catch((e) => {
    console.error("generate failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
} else if (mode === "score") {
  score();
} else {
  console.error("usage: run-extract-review-cli <generate|score> [flags]");
  process.exitCode = 1;
}
