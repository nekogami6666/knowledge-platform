/**
 * inflight_asks のうち受付から 15 分以内の件数(ADR-0035 追記・inflight-cli 用)。
 * 15 分を過ぎた行は強制終了の残り(次回起動時に消える)で、処理中ではないため数えない。
 * token の列は読まない。表が無い(古い bot の DB)なら 0。
 */
import { INTERACTION_TOKEN_MS } from "./ask-lifecycle.js";

/** better-sqlite3 の Database のうち使う部分だけ(テストは :memory: の実 DB を渡す)。 */
export interface CountableDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export function countRecentInflight(db: CountableDb, nowMs: number): number {
  const table = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'inflight_asks'")
    .get();
  if (table === undefined) return 0;
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM inflight_asks WHERE accepted_at_ms > ?")
    .get(nowMs - INTERACTION_TOKEN_MS) as { n: number };
  return row.n;
}
