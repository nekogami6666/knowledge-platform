/**
 * BotStore の本番実装(design.md §4.6)。better-sqlite3。
 * 本ファイルは native モジュール(better-sqlite3)を import するグルーで、統合テストで代替する
 * (CLAUDE.md §12.2)。native バイナリのコンパイルは実行/デプロイ時に `pnpm approve-builds
 * better-sqlite3` で有効化する(Phase 1a の型チェック/テストは createMemoryStore で行うため不要)。
 *
 * 常駐プロセス向けの最小堅牢化: WAL / busy_timeout / user_version(マイグレーション)/ index。
 */
import Database from "better-sqlite3";
import type { BotStore, PendingAction, QueryRecord, RateLimitResult } from "./db.js";

type DB = Database.Database;

const SCHEMA_VERSION = 1;

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      thread_id TEXT,
      question TEXT NOT NULL,
      answer TEXT,
      sources_json TEXT,
      answer_status TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      elapsed_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queries_created_at ON queries (created_at);

    CREATE TABLE IF NOT EXISTS pending_actions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      query_id TEXT,
      payload_json TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_type_state ON pending_actions (type, state);

    CREATE TABLE IF NOT EXISTS rate_limits (
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (subject, kind, window_start)
    );
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** better-sqlite3 による BotStore。path はファイルパス(":memory:" も可)。 */
export function createSqliteStore(path: string): BotStore {
  const db: DB = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);

  const insertQuery = db.prepare(`
    INSERT INTO queries (id, correlation_id, discord_user_id, discord_channel_id, thread_id,
      question, answer, sources_json, answer_status, input_tokens, output_tokens, elapsed_ms, created_at)
    VALUES (@id, @correlationId, @discordUserId, @discordChannelId, @threadId,
      @question, @answer, @sourcesJson, @answerStatus, @inputTokens, @outputTokens, @elapsedMs, @createdAt)
  `);
  const selectQuery = db.prepare("SELECT * FROM queries WHERE id = ?");
  const selectQueries = db.prepare("SELECT * FROM queries ORDER BY created_at");
  const insertAction = db.prepare(`
    INSERT INTO pending_actions (id, type, query_id, payload_json, state, created_at)
    VALUES (@id, @type, @queryId, @payloadJson, @state, @createdAt)
  `);
  const selectActionsAll = db.prepare("SELECT * FROM pending_actions ORDER BY created_at");
  const selectActionsByType = db.prepare(
    "SELECT * FROM pending_actions WHERE type = ? ORDER BY created_at",
  );
  const upsertRate = db.prepare(`
    INSERT INTO rate_limits (subject, kind, window_start, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (subject, kind, window_start) DO UPDATE SET count = count + 1
    RETURNING count
  `);

  return {
    recordQuery(q: QueryRecord) {
      insertQuery.run(q);
    },
    getQuery(id) {
      return (selectQuery.get(id) as QueryRecord | undefined) ?? undefined;
    },
    listQueries() {
      return selectQueries.all() as QueryRecord[];
    },
    queueAction(a: PendingAction) {
      insertAction.run(a);
    },
    listPendingActions(type?: string) {
      const rows = type === undefined ? selectActionsAll.all() : selectActionsByType.all(type);
      return rows as PendingAction[];
    },
    hitRateLimit(subject, kind, windowStart, limit): RateLimitResult {
      const row = upsertRate.get(subject, kind, windowStart) as { count: number };
      return { count: row.count, allowed: row.count <= limit };
    },
    close() {
      db.close();
    },
  };
}
