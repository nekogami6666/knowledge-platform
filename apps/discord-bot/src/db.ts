/**
 * Bot のローカル運用状態(design.md §4.6)。ナレッジは入れない(P5)。
 * `BotStore` がインターフェース。テスト/開発は `createMemoryStore`(native 依存なし)、
 * 本番は `sqlite-store.ts` の `createSqliteStore`(better-sqlite3)を使う。
 *
 * 監査の主識別子は Discord の生 ID(discordUserId / discordChannelId)を必ず残す
 * (members.yaml の表示名マッピングはログの主キーにしない。レビュー所見)。
 */

/** 回答状態。unanswered=NOT_FOUND、delivery_failed=Discord 送信失敗(未回答とは区別)。 */
export type AnswerStatus = "answered" | "unanswered" | "delivery_failed";

/** /ask 1 件の記録(§4.6 queries)。 */
export interface QueryRecord {
  id: string;
  correlationId: string;
  discordUserId: string;
  discordChannelId: string;
  threadId: string | null;
  question: string;
  answer: string | null;
  /** 出典(QaCitation[])の JSON 文字列。 */
  sourcesJson: string | null;
  answerStatus: AnswerStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
  /** ISO 8601(JST、§7.5)。 */
  createdAt: string;
}

/** 確認ボタン等の保留アクション(§4.6 pending_actions)。Phase 1 は question_queue を使う。 */
export interface PendingAction {
  id: string;
  /** "question_queue" | "freshness" | "gap" など。 */
  type: string;
  queryId: string | null;
  payloadJson: string | null;
  /** "pending" | "done" | "skipped" など。 */
  state: string;
  createdAt: string;
}

/** レート制限の1回分の結果。 */
export interface RateLimitResult {
  count: number;
  allowed: boolean;
}

/** Bot のローカル状態ストア(§4.6)。 */
export interface BotStore {
  recordQuery(q: QueryRecord): void;
  getQuery(id: string): QueryRecord | undefined;
  listQueries(): QueryRecord[];

  queueAction(a: PendingAction): void;
  listPendingActions(type?: string): PendingAction[];

  /**
   * (subject, kind, windowStart) の利用を1回数え、count<=limit なら allowed=true を返す(§6.2 直列+制御)。
   * subject 例: "user:123" / "channel:456" / "global"。windowStart はウィンドウ識別子(例 "2026-06-17T10")。
   */
  hitRateLimit(subject: string, kind: string, windowStart: string, limit: number): RateLimitResult;

  close(): void;
}

/** インメモリ実装(テスト/開発用。native 依存なし)。プロセス終了で消える。 */
export function createMemoryStore(): BotStore {
  const queries: QueryRecord[] = [];
  const actions: PendingAction[] = [];
  const counters = new Map<string, number>();

  return {
    recordQuery(q) {
      queries.push({ ...q });
    },
    getQuery(id) {
      return queries.find((q) => q.id === id);
    },
    listQueries() {
      return [...queries];
    },
    queueAction(a) {
      actions.push({ ...a });
    },
    listPendingActions(type) {
      return actions.filter((a) => type === undefined || a.type === type);
    },
    hitRateLimit(subject, kind, windowStart, limit) {
      const key = `${subject}|${kind}|${windowStart}`;
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return { count, allowed: count <= limit };
    },
    close() {},
  };
}
