/**
 * Discord 本文インデックスの SQLite ストア(ADR-0038 D2)。bot.db とは別ファイル。
 *
 * - messages: 本文とメタデータ。`id INTEGER PRIMARY KEY` は FTS の rowid 用の安定キー(VACUUM でも
 *   変わらない)。Discord の ID は `message_id`(UNIQUE・TEXT)で持つ。
 * - messages_fts: FTS5 `tokenize='trigram'` の**外部コンテンツ表**(content='messages')。本文を 2 重に
 *   持たず、検索結果の本文は messages から引く。同期は INSERT/UPDATE/DELETE トリガで行う。
 * - channels: チャンネル(スレッド含む)の名前・親・カーソル。カーソルは REST で連続取得できた位置のみ。
 * - tombstones: 直近に削除した message_id。同期中の古い取得結果で削除済みの本文を復活させない。
 *
 * trigram は 3 文字未満の語に一致しないため、1〜2 文字の語は LIKE で補う(search 参照)。
 * searchAny は事前検索(ADR-0038 追記 2026-10-08・ADR-0041)用の OR 検索で、ツールの search(AND)とは別。
 * 本ファイルは本文をログに出さない(§7.4)。
 */
import Database from "better-sqlite3";
import { compareSnowflake } from "./snowflake.js";

type DB = Database.Database;

const SCHEMA_VERSION = 1;

/** 保存するメッセージ(純粋データ)。時刻は epoch ms。 */
export interface IndexedMessage {
  messageId: string;
  guildId: string;
  /** メッセージが属するチャンネル(スレッドならスレッド ID)。 */
  channelId: string;
  /** 可視性の判定単位 = トップレベルのチャンネル(スレッドなら親、通常チャンネルなら自分)。 */
  parentChannelId: string;
  /** スレッドのメッセージならスレッド ID、それ以外は null。 */
  threadId: string | null;
  authorId: string;
  /** 保存時点の表示名。 */
  authorName: string;
  createdAt: number;
  editedAt: number | null;
  content: string;
  permalink: string;
}

/** チャンネルのメタデータ(スレッド・フォーラムも含む)。 */
export interface IndexedChannel {
  channelId: string;
  guildId: string;
  /** スレッドなら親、それ以外は自分。 */
  parentChannelId: string;
  name: string;
  kind: "text" | "forum" | "thread";
}

export interface ChannelCursor {
  /** REST で連続取得できた最後の snowflake(null = 未取得)。 */
  lastMessageId: string | null;
  /** 前回の取得が上限に達せず末尾まで届いたか(false なら次回は照合せずカーソルから続きを取る)。 */
  caughtUp: boolean;
}

export type UpsertOutcome = "inserted" | "updated" | "unchanged" | "stale" | "tombstoned";

export interface SearchParams {
  /** 3 文字以上の語(FTS)。 */
  ftsTerms: readonly string[];
  /** 1〜2 文字の語(LIKE)。 */
  likeTerms: readonly string[];
  /** 検索してよいトップレベルのチャンネル(質問者に見える ∩ bot に見える)。空なら 0 件。 */
  parentChannelIds: readonly string[];
  sinceMs?: number;
  untilMs?: number;
  limit: number;
}

export interface SearchHit {
  messageId: string;
  guildId: string;
  channelId: string;
  parentChannelId: string;
  threadId: string | null;
  authorName: string;
  createdAt: number;
  editedAt: number | null;
  content: string;
  permalink: string;
}

/** 1 文字以上の語を含む OR 検索(事前検索用・ADR-0038 追記 2026-10-08)。 */
export interface AnySearchParams {
  /** 検索語(空白で分割済み)。3 文字以上は FTS の OR、2 文字以下は一致数の数え上げ(と、3 文字以上が無いときの LIKE の OR)。 */
  terms: readonly string[];
  /** 検索してよいトップレベルのチャンネル(質問者に見える ∩ bot に見える = ADR-0038 D5)。空なら 0 件。 */
  parentChannelIds: readonly string[];
  sinceMs?: number;
  untilMs?: number;
  limit: number;
}

/** searchAny の 1 件。並びは matchedTerms の多い順 → bm25 → 新しい順。 */
export interface ScoredSearchHit extends SearchHit {
  /** FTS5 の bm25(小さいほど関連が強い・通常は負)。LIKE だけで取った候補は null。 */
  bm25: number | null;
  /** 本文に含まれた検索語の数(重複を除く・大小無視・2 文字以下の語も数える)。 */
  matchedTerms: number;
}

export interface DiscordIndexStore {
  /** 挿入か更新。edited_at が保存済みより古い取得結果・削除済み(tombstone)は捨てる。 */
  upsertMessage(m: IndexedMessage): UpsertOutcome;
  /** upsertMessage を 1 トランザクションでまとめて行う(取り込みの 1 ページ分・ADR-0038 追記 A4)。 */
  upsertMany(ms: readonly IndexedMessage[]): UpsertOutcome[];
  /** 削除し tombstone を残す。戻りは実際に消えた本文の件数。 */
  deleteMessages(messageIds: readonly string[], nowMs: number): number;
  /** channel_id の作成時刻範囲 [fromMs, toMs] にある保存済み message_id(照合の削除判定用)。 */
  listMessageIds(channelId: string, fromMs: number, toMs: number): string[];
  upsertChannel(ch: IndexedChannel): void;
  getCursor(channelId: string): ChannelCursor;
  /** カーソルを前進させる(snowflake の数値比較で後退はしない)。caughtUp は常に上書き。 */
  advanceCursor(channelId: string, lastMessageId: string | null, caughtUp: boolean): void;
  /** チャンネル(と、それを親に持つスレッド)の本文・メタデータを削除する。 */
  purgeChannel(channelId: string): number;
  /**
   * ギルド内で、親が allowedParents に無い本文、または自身・親が excluded にある本文を削除する
   * (bot が見えなくなった・permanent_exclude に入ったチャンネル)。メタデータも同様に消す。
   */
  purgeGuildExcept(
    guildId: string,
    allowedParents: ReadonlySet<string>,
    excluded: ReadonlySet<string>,
  ): number;
  /** keepGuildIds に無いギルドの本文・メタデータを削除する(bot がギルドから外れた)。 */
  purgeGuildsNotIn(keepGuildIds: ReadonlySet<string>): number;
  /** created_at が cutoffMs より前の本文を削除する(保持期間)。 */
  purgeOlderThan(cutoffMs: number): number;
  pruneTombstones(cutoffMs: number): number;
  search(params: SearchParams): SearchHit[];
  /**
   * 語の OR 検索(事前検索用)。検索範囲の絞り込みは search と同じ。候補を bm25 で多めに取り、
   * 一致した語の数を数えて並べ直す(ADR-0038 追記 A3)。
   */
  searchAny(params: AnySearchParams): ScoredSearchHit[];
  /** チャンネル名(メタデータに無ければ含めない)。 */
  channelNames(channelIds: readonly string[]): Map<string, string>;
  /** トップレベルのチャンネル一覧(ツールの channel 引数の名前解決用)。 */
  listChannels(guildId?: string): IndexedChannel[];
  counts(): { messages: number; channels: number };
  close(): void;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      parent_channel_id TEXT NOT NULL,
      thread_id TEXT,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      content TEXT NOT NULL,
      permalink TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages (channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_parent_created ON messages (parent_channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_guild ON messages (guild_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

    -- 外部コンテンツ表(本文は messages が持つ)。trigram は 3 文字以上の部分一致(大小無視)。
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      parent_channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_message_id TEXT,
      caught_up INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels (parent_channel_id);

    CREATE TABLE IF NOT EXISTS tombstones (
      message_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    );
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

interface MessageRow {
  message_id: string;
  guild_id: string;
  channel_id: string;
  parent_channel_id: string;
  thread_id: string | null;
  author_name: string;
  created_at: number;
  edited_at: number | null;
  content: string;
  permalink: string;
}

function toHit(r: MessageRow): SearchHit {
  return {
    messageId: r.message_id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    parentChannelId: r.parent_channel_id,
    threadId: r.thread_id,
    authorName: r.author_name,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    content: r.content,
    permalink: r.permalink,
  };
}

/** FTS5 のフレーズ(二重引用符で囲み、内部の " は "" に)。演算子・列指定として解釈させない。 */
export function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** searchAny の語数の上限(長い文をそのまま渡されたときの防御)。 */
const MAX_ANY_TERMS = 16;
/** searchAny で bm25 順に取る候補の倍率(一致数で並べ直すため上限より多めに取る)。 */
const ANY_CANDIDATE_FACTOR = 5;
const ANY_MIN_CANDIDATES = 50;

/** LIKE のパターン(% _ \ をエスケープして部分一致に)。ESCAPE '\' と組で使う。 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * ストアを開く(`:memory:` 可)。WAL / busy_timeout / マイグレーションを適用する。
 * better-sqlite3 は同期 API のため、1 つの呼び出しの途中に他の呼び出しが割り込むことはない。
 */
export function createDiscordIndexStore(path: string): DiscordIndexStore {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);

  const getMsg = db.prepare<
    [string],
    { created_at: number; edited_at: number | null; content: string }
  >("SELECT created_at, edited_at, content FROM messages WHERE message_id = ?");
  const isTombstoned = db.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM tombstones WHERE message_id = ?",
  );
  const insertMsg = db.prepare(
    `INSERT INTO messages (message_id, guild_id, channel_id, parent_channel_id, thread_id, author_id,
       author_name, created_at, edited_at, content, permalink)
     VALUES (@messageId, @guildId, @channelId, @parentChannelId, @threadId, @authorId,
       @authorName, @createdAt, @editedAt, @content, @permalink)`,
  );
  const updateMsg = db.prepare(
    `UPDATE messages SET guild_id=@guildId, channel_id=@channelId, parent_channel_id=@parentChannelId,
       thread_id=@threadId, author_id=@authorId, author_name=@authorName, created_at=@createdAt,
       edited_at=@editedAt, content=@content, permalink=@permalink
     WHERE message_id=@messageId`,
  );
  const deleteMsg = db.prepare("DELETE FROM messages WHERE message_id = ?");
  const insertTomb = db.prepare(
    "INSERT INTO tombstones (message_id, deleted_at) VALUES (?, ?) ON CONFLICT(message_id) DO UPDATE SET deleted_at = excluded.deleted_at",
  );

  const upsertMessage = (m: IndexedMessage): UpsertOutcome => {
    if (isTombstoned.get(m.messageId) !== undefined) return "tombstoned";
    const cur = getMsg.get(m.messageId);
    if (cur === undefined) {
      insertMsg.run(m);
      return "inserted";
    }
    // 取得結果が保存済みより古い版(同期中に届いたライブ編集を巻き戻さない)。
    const curVersion = cur.edited_at ?? cur.created_at;
    const newVersion = m.editedAt ?? m.createdAt;
    if (newVersion < curVersion) return "stale";
    if (cur.content === m.content && cur.edited_at === m.editedAt) return "unchanged";
    updateMsg.run(m);
    return "updated";
  };

  const upsertManyTx = db.transaction((ms: readonly IndexedMessage[]): UpsertOutcome[] =>
    ms.map((m) => upsertMessage(m)),
  );

  const deleteMessages = db.transaction((ids: readonly string[], nowMs: number): number => {
    let n = 0;
    for (const id of ids) {
      n += deleteMsg.run(id).changes;
      insertTomb.run(id, nowMs);
    }
    return n;
  });

  const getCursorStmt = db.prepare<[string], { last_message_id: string | null; caught_up: number }>(
    "SELECT last_message_id, caught_up FROM channels WHERE channel_id = ?",
  );

  const purgeChannelTx = db.transaction((channelId: string): number => {
    const n = db
      .prepare("DELETE FROM messages WHERE channel_id = ? OR parent_channel_id = ?")
      .run(channelId, channelId).changes;
    db.prepare("DELETE FROM channels WHERE channel_id = ? OR parent_channel_id = ?").run(
      channelId,
      channelId,
    );
    return n;
  });

  const purgeGuildExceptTx = db.transaction(
    (guildId: string, allowed: readonly string[], excluded: readonly string[]): number => {
      const a = JSON.stringify(allowed);
      const e = JSON.stringify(excluded);
      const n = db
        .prepare(
          `DELETE FROM messages WHERE guild_id = ? AND (
             parent_channel_id NOT IN (SELECT value FROM json_each(?))
             OR channel_id IN (SELECT value FROM json_each(?))
             OR parent_channel_id IN (SELECT value FROM json_each(?)))`,
        )
        .run(guildId, a, e, e).changes;
      db.prepare(
        `DELETE FROM channels WHERE guild_id = ? AND (
           parent_channel_id NOT IN (SELECT value FROM json_each(?))
           OR channel_id IN (SELECT value FROM json_each(?))
           OR parent_channel_id IN (SELECT value FROM json_each(?)))`,
      ).run(guildId, a, e, e);
      return n;
    },
  );

  const purgeGuildsNotInTx = db.transaction((keep: readonly string[]): number => {
    const k = JSON.stringify(keep);
    const n = db
      .prepare("DELETE FROM messages WHERE guild_id NOT IN (SELECT value FROM json_each(?))")
      .run(k).changes;
    db.prepare("DELETE FROM channels WHERE guild_id NOT IN (SELECT value FROM json_each(?))").run(
      k,
    );
    return n;
  });

  return {
    upsertMessage,
    upsertMany: (ms) => (ms.length === 0 ? [] : upsertManyTx(ms)),
    deleteMessages: (ids, nowMs) => (ids.length === 0 ? 0 : deleteMessages(ids, nowMs)),
    listMessageIds(channelId, fromMs, toMs) {
      return db
        .prepare<[string, number, number], { message_id: string }>(
          "SELECT message_id FROM messages WHERE channel_id = ? AND created_at BETWEEN ? AND ?",
        )
        .all(channelId, fromMs, toMs)
        .map((r) => r.message_id);
    },
    upsertChannel(ch) {
      db.prepare(
        `INSERT INTO channels (channel_id, guild_id, parent_channel_id, name, kind)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id,
           parent_channel_id = excluded.parent_channel_id, name = excluded.name, kind = excluded.kind`,
      ).run(ch.channelId, ch.guildId, ch.parentChannelId, ch.name, ch.kind);
    },
    getCursor(channelId) {
      const r = getCursorStmt.get(channelId);
      return { lastMessageId: r?.last_message_id ?? null, caughtUp: r?.caught_up === 1 };
    },
    advanceCursor(channelId, lastMessageId, caughtUp) {
      const cur = getCursorStmt.get(channelId);
      if (cur === undefined) return; // メタデータ未登録のチャンネル(upsertChannel が先)
      const next =
        lastMessageId === null
          ? cur.last_message_id
          : cur.last_message_id === null || compareSnowflake(lastMessageId, cur.last_message_id) > 0
            ? lastMessageId
            : cur.last_message_id;
      db.prepare("UPDATE channels SET last_message_id = ?, caught_up = ? WHERE channel_id = ?").run(
        next,
        caughtUp ? 1 : 0,
        channelId,
      );
    },
    purgeChannel: (channelId) => purgeChannelTx(channelId),
    purgeGuildExcept: (guildId, allowedParents, excluded) =>
      purgeGuildExceptTx(guildId, [...allowedParents], [...excluded]),
    purgeGuildsNotIn: (keep) => purgeGuildsNotInTx([...keep]),
    purgeOlderThan(cutoffMs) {
      return db.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoffMs).changes;
    },
    pruneTombstones(cutoffMs) {
      return db.prepare("DELETE FROM tombstones WHERE deleted_at < ?").run(cutoffMs).changes;
    },
    search(p) {
      if (p.parentChannelIds.length === 0) return [];
      if (p.ftsTerms.length === 0 && p.likeTerms.length === 0) return [];
      const where: string[] = ["m.parent_channel_id IN (SELECT value FROM json_each(@parents))"];
      const params: Record<string, unknown> = {
        parents: JSON.stringify(p.parentChannelIds),
        limit: p.limit,
      };
      if (p.sinceMs !== undefined) {
        where.push("m.created_at >= @since");
        params.since = p.sinceMs;
      }
      if (p.untilMs !== undefined) {
        where.push("m.created_at <= @until");
        params.until = p.untilMs;
      }
      p.likeTerms.forEach((t, i) => {
        where.push(`m.content LIKE @like${i} ESCAPE '\\'`);
        params[`like${i}`] = likePattern(t);
      });
      const cols = `m.message_id, m.guild_id, m.channel_id, m.parent_channel_id, m.thread_id,
        m.author_name, m.created_at, m.edited_at, m.content, m.permalink`;
      let sql: string;
      if (p.ftsTerms.length > 0) {
        // 語はすべてフレーズとして AND(FTS の構文をモデルに組ませない)。関連度順 → 新しい順。
        params.match = p.ftsTerms.map(ftsPhrase).join(" AND ");
        sql = `SELECT ${cols} FROM messages_fts f JOIN messages m ON m.id = f.rowid
               WHERE messages_fts MATCH @match AND ${where.join(" AND ")}
               ORDER BY bm25(messages_fts), m.created_at DESC LIMIT @limit`;
      } else {
        sql = `SELECT ${cols} FROM messages m WHERE ${where.join(" AND ")}
               ORDER BY m.created_at DESC LIMIT @limit`;
      }
      return db
        .prepare(sql)
        .all(params)
        .map((r) => toHit(r as MessageRow));
    },
    searchAny(p) {
      if (p.parentChannelIds.length === 0 || p.limit <= 0) return [];
      // 大小無視で重複を除く(trigram も大小無視)。
      const seen = new Set<string>();
      const terms: string[] = [];
      for (const raw of p.terms) {
        const t = raw.trim();
        const key = t.toLowerCase();
        if (t === "" || seen.has(key)) continue;
        seen.add(key);
        terms.push(t);
        if (terms.length >= MAX_ANY_TERMS) break;
      }
      if (terms.length === 0) return [];
      const ftsTerms = terms.filter((t) => [...t].length >= 3);
      const where: string[] = ["m.parent_channel_id IN (SELECT value FROM json_each(@parents))"];
      const params: Record<string, unknown> = {
        parents: JSON.stringify(p.parentChannelIds),
        candidates: Math.max(p.limit * ANY_CANDIDATE_FACTOR, ANY_MIN_CANDIDATES),
      };
      if (p.sinceMs !== undefined) {
        where.push("m.created_at >= @since");
        params.since = p.sinceMs;
      }
      if (p.untilMs !== undefined) {
        where.push("m.created_at <= @until");
        params.until = p.untilMs;
      }
      const cols = `m.message_id, m.guild_id, m.channel_id, m.parent_channel_id, m.thread_id,
        m.author_name, m.created_at, m.edited_at, m.content, m.permalink`;
      let sql: string;
      if (ftsTerms.length > 0) {
        // 語はすべてフレーズとして OR(FTS の構文を呼び出し元に組ませない)。
        params.match = ftsTerms.map(ftsPhrase).join(" OR ");
        sql = `SELECT ${cols}, bm25(messages_fts) AS score FROM messages_fts f
               JOIN messages m ON m.id = f.rowid
               WHERE messages_fts MATCH @match AND ${where.join(" AND ")}
               ORDER BY score, m.created_at DESC LIMIT @candidates`;
      } else {
        // 3 文字以上の語が無い: 短い語の LIKE の OR(bm25 は無し・新しい順)。
        const likes = terms.map((t, i) => {
          params[`like${i}`] = likePattern(t);
          return `m.content LIKE @like${i} ESCAPE '\\'`;
        });
        sql = `SELECT ${cols}, NULL AS score FROM messages m
               WHERE ${where.join(" AND ")} AND (${likes.join(" OR ")})
               ORDER BY m.created_at DESC LIMIT @candidates`;
      }
      const lowered = terms.map((t) => t.toLowerCase());
      return db
        .prepare(sql)
        .all(params)
        .map((r): ScoredSearchHit => {
          const row = r as MessageRow & { score: number | null };
          const body = row.content.toLowerCase();
          return {
            ...toHit(row),
            bm25: row.score,
            matchedTerms: lowered.filter((t) => body.includes(t)).length,
          };
        })
        .sort(
          (a, b) =>
            b.matchedTerms - a.matchedTerms ||
            (a.bm25 ?? Number.POSITIVE_INFINITY) - (b.bm25 ?? Number.POSITIVE_INFINITY) ||
            b.createdAt - a.createdAt,
        )
        .slice(0, p.limit);
    },
    channelNames(channelIds) {
      const out = new Map<string, string>();
      if (channelIds.length === 0) return out;
      const rows = db
        .prepare<[string], { channel_id: string; name: string }>(
          "SELECT channel_id, name FROM channels WHERE channel_id IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify(channelIds));
      for (const r of rows) out.set(r.channel_id, r.name);
      return out;
    },
    listChannels(guildId) {
      const rows = db
        .prepare<
          [],
          {
            channel_id: string;
            guild_id: string;
            parent_channel_id: string;
            name: string;
            kind: IndexedChannel["kind"];
          }
        >("SELECT channel_id, guild_id, parent_channel_id, name, kind FROM channels")
        .all();
      return rows
        .filter((r) => guildId === undefined || r.guild_id === guildId)
        .map((r) => ({
          channelId: r.channel_id,
          guildId: r.guild_id,
          parentChannelId: r.parent_channel_id,
          name: r.name,
          kind: r.kind,
        }));
    },
    counts() {
      const m = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM messages").get();
      const c = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM channels").get();
      return { messages: m?.n ?? 0, channels: c?.n ?? 0 };
    },
    close() {
      db.close();
    },
  };
}
