/**
 * 処理中 /ask の件数を表示する CLI(ADR-0035 追記)。docs/deploy/update.sh が bot の再作成の前に呼び、
 * 回答中の質問があれば警告を出す(止めはしない)。ホストの node + better-sqlite3 で動く
 * (stats-cli / recordings-cleanup-cli と同じ流儀)。
 *
 * - bot.db を読み取り専用で開く(マイグレーション・表の作成はしない)。
 * - inflight_asks のうち受付から 15 分以内の行数だけを 1 行で出す。token の列は読まない(§9.1)。
 * - 表が無い(古い bot)なら 0。開けなければ stderr に理由を出して exit 1。
 */
import Database from "better-sqlite3";
import { countRecentInflight } from "./inflight-count.js";

function main(): void {
  const path = process.env.DB_PATH ?? "./data/bot.db";
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    console.log(String(countRecentInflight(db, Date.now())));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`inflight-cli: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
