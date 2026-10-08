/**
 * BotStore の本番実装(design.md §4.6)。better-sqlite3。
 * 本ファイルは native モジュール(better-sqlite3)を import するグルーで、統合テストで代替する
 * (CLAUDE.md §12.2)。native バイナリのコンパイルは実行/デプロイ時に `pnpm approve-builds
 * better-sqlite3` で有効化する(Phase 1a の型チェック/テストは createMemoryStore で行うため不要)。
 *
 * 常駐プロセス向けの最小堅牢化: WAL / busy_timeout / user_version(マイグレーション)/ index。
 */
import Database from "better-sqlite3";
import type {
  BotStore,
  InflightAsk,
  InflightAskStore,
  ManagedClone,
  ManagedCloneStore,
  PendingAction,
  QueryRecord,
  RateLimitResult,
  SharedAnswer,
  SharedAnswerStore,
} from "./db.js";

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

/**
 * 処理中 /ask の表(強制終了からの後始末・ADR-0035 追記)。**user_version を消費しない**。
 *
 * - 追加のみ・冪等(IF NOT EXISTS)で、開くたびに実行する。行は最長 15 分しか生きない揮発データで、
 *   列の移行が要らないため版番号で管理する必要が無い。
 * - bot.db はホスト側バッチ(gap-tracker / freshness / stats / recordings-cleanup)と共有しており、
 *   各バッチも同じ createSqliteStore を通る。古いコードのバッチは本表を知らないまま素通りし
 *   (`current >= SCHEMA_VERSION` で migrate を抜ける)、新しいコードのバッチが先に開いても同じ表を作るだけ。
 * - 後から足した managed_clones・shared_answers も同じ流儀で、版番号は 1 のまま。
 *   将来 migrate の版に畳む場合も、この文は冪等なのでそのまま任意の vN 段へ移せる。
 */
function ensureInflightAsksTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inflight_asks (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      interaction_token TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      correlation_id TEXT NOT NULL
    );
  `);
}

/**
 * /ask 回答の公開共有の記録(ADR-0040)。**user_version を消費しない**(inflight_asks と同じ流儀)。
 * 追加のみ・冪等で開くたびに実行する。bot.db を共有するホスト側バッチは本表を読まない。
 * message_id は投稿前の予約の間だけ NULL(1 回答 1 回の排他を主キーで取るため・ADR-0040 D4)。
 */
function ensureSharedAnswersTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_answers (
      query_id TEXT PRIMARY KEY,
      shared_at TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      shared_by TEXT NOT NULL
    );
  `);
}

/**
 * bot が all_visible の列挙由来として作った clone dir の記録(ADR-0036 D4)。**user_version を消費しない**
 * (inflight_asks と同じ流儀)。追加のみ・冪等で開くたびに実行する。bot.db を共有するホスト側バッチは
 * 本表を読まず、古いコードのバッチは素通りする。削除してよい clone はここに記録がある dir だけ。
 */
function ensureManagedClonesTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_clones (
      dir TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
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
export function createSqliteStore(
  path: string,
): BotStore & InflightAskStore & SharedAnswerStore & ManagedCloneStore {
  const db: DB = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  ensureInflightAsksTable(db);
  ensureSharedAnswersTable(db);
  ensureManagedClonesTable(db);

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
  const updateActionDone = db.prepare("UPDATE pending_actions SET state = 'done' WHERE id = ?");
  const updateActionState = db.prepare("UPDATE pending_actions SET state = ? WHERE id = ?");
  const updateActionPayload = db.prepare(
    "UPDATE pending_actions SET payload_json = @payloadJson WHERE id = @id",
  );
  const upsertRate = db.prepare(`
    INSERT INTO rate_limits (subject, kind, window_start, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (subject, kind, window_start) DO UPDATE SET count = count + 1
    RETURNING count
  `);
  const insertInflight = db.prepare(`
    INSERT OR REPLACE INTO inflight_asks (id, application_id, interaction_token, accepted_at_ms, correlation_id)
    VALUES (@id, @applicationId, @token, @acceptedAtMs, @correlationId)
  `);
  const deleteInflight = db.prepare("DELETE FROM inflight_asks WHERE id = ?");
  const selectInflight = db.prepare("SELECT * FROM inflight_asks ORDER BY accepted_at_ms");
  // 予約は INSERT OR IGNORE の changes で判定する(主キー = 1 回答 1 回・ADR-0040 D4)。
  const insertShared = db.prepare(`
    INSERT OR IGNORE INTO shared_answers (query_id, shared_at, channel_id, message_id, shared_by)
    VALUES (@queryId, @sharedAt, @channelId, NULL, @sharedBy)
  `);
  const updateSharedMessage = db.prepare(
    "UPDATE shared_answers SET message_id = ? WHERE query_id = ?",
  );
  const deleteSharedClaim = db.prepare(
    "DELETE FROM shared_answers WHERE query_id = ? AND message_id IS NULL",
  );
  const selectShared = db.prepare("SELECT * FROM shared_answers WHERE query_id = ?");
  const selectManaged = db.prepare("SELECT * FROM managed_clones ORDER BY dir");
  // 同じ dir の再記録は冪等(最初の created_at を保つ)。
  const upsertManaged = db.prepare(`
    INSERT INTO managed_clones (dir, repo, created_at) VALUES (@dir, @repo, @createdAt)
    ON CONFLICT (dir) DO UPDATE SET repo = excluded.repo
  `);
  const deleteManaged = db.prepare("DELETE FROM managed_clones WHERE dir = ?");

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
    markActionDone(id) {
      updateActionDone.run(id);
    },
    setActionState(id, state) {
      updateActionState.run(state, id);
    },
    setActionPayload(id, payloadJson) {
      updateActionPayload.run({ id, payloadJson });
    },
    hitRateLimit(subject, kind, windowStart, limit): RateLimitResult {
      const row = upsertRate.get(subject, kind, windowStart) as { count: number };
      return { count: row.count, allowed: row.count <= limit };
    },
    addInflightAsk(row: InflightAsk) {
      insertInflight.run(row);
    },
    removeInflightAsk(id) {
      deleteInflight.run(id);
    },
    listInflightAsks(): InflightAsk[] {
      const rows = selectInflight.all() as Array<{
        id: string;
        application_id: string;
        interaction_token: string;
        accepted_at_ms: number;
        correlation_id: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        applicationId: r.application_id,
        token: r.interaction_token,
        acceptedAtMs: r.accepted_at_ms,
        correlationId: r.correlation_id,
      }));
    },
    claimSharedAnswer(row) {
      return (
        insertShared.run({
          queryId: row.queryId,
          sharedAt: row.sharedAt,
          channelId: row.channelId,
          sharedBy: row.sharedBy,
        }).changes === 1
      );
    },
    completeSharedAnswer(queryId, messageId) {
      updateSharedMessage.run(messageId, queryId);
    },
    releaseSharedAnswer(queryId) {
      deleteSharedClaim.run(queryId);
    },
    getSharedAnswer(queryId): SharedAnswer | undefined {
      const r = selectShared.get(queryId) as
        | {
            query_id: string;
            shared_at: string;
            channel_id: string;
            message_id: string | null;
            shared_by: string;
          }
        | undefined;
      if (r === undefined) return undefined;
      return {
        queryId: r.query_id,
        sharedAt: r.shared_at,
        channelId: r.channel_id,
        messageId: r.message_id,
        sharedBy: r.shared_by,
      };
    },
    listManagedClones(): ManagedClone[] {
      const rows = selectManaged.all() as Array<{ dir: string; repo: string; created_at: string }>;
      return rows.map((r) => ({ dir: r.dir, repo: r.repo, createdAt: r.created_at }));
    },
    addManagedClone(c) {
      upsertManaged.run({ dir: c.dir, repo: c.repo, createdAt: c.createdAt });
    },
    removeManagedClone(dir) {
      deleteManaged.run(dir);
    },
    close() {
      db.close();
    },
  };
}
