/**
 * System One の較正用ラベルを bot.db から JSONL に書き出す CLI(ADR-0041 D7)。VM のホストで月 1 回、手で実行する:
 *
 *   DB_PATH=~/stratum/data/bot.db node dist/system-one/export-labels-cli.js /path/outside/repo/labels.jsonl
 *
 * - bot.db を**読み取り専用**で開く(マイグレーション・表の作成はしない。inflight-cli と同じ流儀)。
 * - 出力は質問文を含むため、git の作業ツリーの中には書かない(拒否する)。ファイルは 0600 で作る。
 * - 出力した JSONL を evals/src/calibrate-system-one.ts に渡して weights.json を作り直す。
 */
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { outsideGitWorktree, type QueryLabelSource, toLabelRows } from "./export-labels.js";

function main(): void {
  const out = process.argv[2];
  if (out === undefined || out === "") {
    throw new Error("使い方: export-labels-cli <出力 JSONL のパス(リポジトリの外)>");
  }
  const inside = outsideGitWorktree(out);
  if (inside !== null) throw new Error(inside);
  const path = process.env.DB_PATH ?? "./data/bot.db";
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hasDecisions =
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_one_decisions'",
        )
        .get() !== undefined;
    const sql = hasDecisions
      ? `SELECT q.question AS question, q.sources_json AS sourcesJson, q.created_at AS createdAt,
           d.mode AS systemOneMode
         FROM queries q LEFT JOIN system_one_decisions d ON d.query_id = q.id
         WHERE q.answer_status = 'answered' AND q.sources_json IS NOT NULL ORDER BY q.created_at`
      : `SELECT question, sources_json AS sourcesJson, created_at AS createdAt, NULL AS systemOneMode
         FROM queries WHERE answer_status = 'answered' AND sources_json IS NOT NULL ORDER BY created_at`;
    const rows = toLabelRows(db.prepare(sql).all() as QueryLabelSource[]);
    writeFileSync(
      out,
      rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""),
      {
        mode: 0o600,
      },
    );
    // 件数だけを出す(質問文は出さない)。
    console.log(`system-one labels: ${rows.length} 件`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`export-labels-cli: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
