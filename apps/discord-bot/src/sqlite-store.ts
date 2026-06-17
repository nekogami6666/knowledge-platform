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
      feedback TEXT,
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

    -- 固定タイムバケット方式((subject,kind,window_start) ごとに1行)。スライディングではない。
    -- 古いウィンドウ行は読まれないが単調増加する。掃除(DELETE WHERE window_start < ?)は
    -- スケジューラ基盤が入る PR-4+ で行う(PR-3b では呼び出し元が無く dead code になるため未実装)。
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

// sqlite の行は snake_case。`SELECT *` を `as QueryRecord`(camelCase)へ素キャストすると
// 各フィールドが実行時 undefined になる(メモリ実装と乖離)。必ず下記マッパで写す。
interface QueryRow {
  id: string;
  correlation_id: string;
  discord_user_id: string;
  discord_channel_id: string;
  thread_id: string | null;
  question: string;
  answer: string | null;
  sources_json: string | null;
  answer_status: QueryRecord["answerStatus"];
  feedback: QueryRecord["feedback"];
  input_tokens: number | null;
  output_tokens: number | null;
  elapsed_ms: number | null;
  created_at: string;
}

interface ActionRow {
  id: string;
  type: string;
  query_id: string | null;
  payload_json: string | null;
  state: string;
  created_at: string;
}

function toQueryRecord(r: QueryRow): QueryRecord {
  return {
    id: r.id,
    correlationId: r.correlation_id,
    discordUserId: r.discord_user_id,
    discordChannelId: r.discord_channel_id,
    threadId: r.thread_id,
    question: r.question,
    answer: r.answer,
    sourcesJson: r.sources_json,
    answerStatus: r.answer_status,
    feedback: r.feedback ?? null,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    elapsedMs: r.elapsed_ms,
    createdAt: r.created_at,
  };
}

function toPendingAction(r: ActionRow): PendingAction {
  return {
    id: r.id,
    type: r.type,
    queryId: r.query_id,
    payloadJson: r.payload_json,
    state: r.state,
    createdAt: r.created_at,
  };
}

/** better-sqlite3 による BotStore。path はファイルパス(":memory:" も可)。 */
export function createSqliteStore(path: string): BotStore {
  const db: DB = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);

  // @feedback を列・VALUES の双方に含めること。QueryRecord に feedback がある以上、
  // 列を欠くと better-sqlite3 の named-param 厳密一致で recordQuery が実行時に throw する。
  const insertQuery = db.prepare(`
    INSERT INTO queries (id, correlation_id, discord_user_id, discord_channel_id, thread_id,
      question, answer, sources_json, answer_status, feedback, input_tokens, output_tokens, elapsed_ms, created_at)
    VALUES (@id, @correlationId, @discordUserId, @discordChannelId, @threadId,
      @question, @answer, @sourcesJson, @answerStatus, @feedback, @inputTokens, @outputTokens, @elapsedMs, @createdAt)
  `);
  const selectQuery = db.prepare("SELECT * FROM queries WHERE id = ?");
  const selectQueries = db.prepare("SELECT * FROM queries ORDER BY created_at");
  const updateFeedback = db.prepare("UPDATE queries SET feedback = ? WHERE id = ?");
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
      const row = selectQuery.get(id) as QueryRow | undefined;
      return row ? toQueryRecord(row) : undefined;
    },
    listQueries() {
      return (selectQueries.all() as QueryRow[]).map(toQueryRecord);
    },
    setFeedback(id, value) {
      updateFeedback.run(value, id);
    },
    queueAction(a: PendingAction) {
      insertAction.run(a);
    },
    listPendingActions(type?: string) {
      const rows = (
        type === undefined ? selectActionsAll.all() : selectActionsByType.all(type)
      ) as ActionRow[];
      return rows.map(toPendingAction);
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
