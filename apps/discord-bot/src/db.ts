/**
 * Bot のローカル運用状態(design.md §4.6)。ナレッジは入れない(P5)。
 * `BotStore` がインターフェース。テスト/開発は `createMemoryStore`(native 依存なし)、
 * 本番は `sqlite-store.ts` の `createSqliteStore`(better-sqlite3)を使う。
 *
 * 監査の主識別子は Discord の生 ID(discordUserId / discordChannelId)を必ず残す
 * (members 対応表(KB _meta/members.yaml)の表示名マッピングはログの主キーにしない。レビュー所見)。
 */

/**
 * 回答状態。unanswered=NOT_FOUND(出典なし)、delivery_failed=Discord 送信失敗、
 * timeout=検索タイムアウト(§6.2 失敗時挙動。ASK_TIMEOUT_MS 調整の判断材料として error と区別)、
 * error=検索/同期などの内部エラー(いずれも未回答とは区別。timeout/error はキューに積まない)。
 * timeout_skipped=受付からの期限を過ぎてから順番が来たため検索しなかった(ADR-0035 追記 D2')、
 * interrupted=bot の再起動(正常終了)で検索を中断した・順番待ちのまま終了した(ADR-0035 追記)。
 * いずれもナレッジの欠落ではないため question_queue には積まない。
 */
export type AnswerStatus =
  | "answered"
  | "unanswered"
  | "delivery_failed"
  | "timeout"
  | "error"
  | "timeout_skipped"
  | "interrupted";

/** 回答への評価(👍👎、§4.6 queries)。未評価は null。 */
export type Feedback = "up" | "down" | null;

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
  /** 👍👎 評価(§4.6)。PR-4 でボタン押下時に setFeedback で更新。初期は null。 */
  feedback: Feedback;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
  /** ISO 8601(JST、§7.5)。 */
  createdAt: string;
}

/** 確認ボタン等の保留アクション(§4.6 pending_actions)。Phase 1 は question_queue を使う。 */
export interface PendingAction {
  id: string;
  /** "question_queue" | "gap_answer" | "pr_merge" | "freshness" など。 */
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
  /** 👍👎 評価を記録/更新する(§4.6。PR-4 のリアクション処理が呼ぶ)。未知 id は no-op。 */
  setFeedback(id: string, value: Feedback): void;

  queueAction(a: PendingAction): void;
  listPendingActions(type?: string): PendingAction[];
  /**
   * 保留アクションを処理済み(state="done")にする(§6.5。gap-tracker が消費後に呼ぶ)。
   * これが無いとバッチが毎回同じキューを再処理する。未知 id は no-op。
   */
  markActionDone(id: string): void;

  /**
   * 保留アクションの state を進める(§4.6。freshness の "pending"→"sent" 等・ADR-0019 D2)。
   * "done" 以外の中間状態への遷移に使う(消費の完了は markActionDone)。未知 id は no-op。
   */
  setActionState(id: string, state: string): void;

  /**
   * 保留アクションの payload を差し替える(ADR-0028 D1)。interview セッションの
   * チャンク追記・STT キャッシュのように、消費前に payload が育つ type が使う。未知 id は no-op。
   */
  setActionPayload(id: string, payloadJson: string): void;

  /**
   * (subject, kind, windowStart) の利用を1回数え、count<=limit なら allowed=true を返す(§6.2 直列+制御)。
   * subject 例: "user:123" / "channel:456" / "global"。windowStart はウィンドウ識別子(例 "2026-06-17T10")。
   */
  hitRateLimit(subject: string, kind: string, windowStart: string, limit: number): RateLimitResult;

  close(): void;
}

/**
 * 処理中の /ask 1 件(強制終了からの後始末用・ADR-0035 追記)。受付時に入れ、完了時に消す。
 * token は interaction の webhook token(その ephemeral 応答を 15 分間だけ編集できる)。
 * **ログ・例外文言に出さない**(§9.1)。質問本文は持たない。
 */
export interface InflightAsk {
  /** 行 ID(受付ごとに発番)。 */
  id: string;
  applicationId: string;
  token: string;
  /** 受付時刻(epoch ms)。起動時の後始末で 15 分以内かを判定する。 */
  acceptedAtMs: number;
  correlationId: string;
}

/** 処理中 /ask の記録(BotStore とは別の口。bot 本体だけが使う)。 */
export interface InflightAskStore {
  addInflightAsk(row: InflightAsk): void;
  /** 未知 id は no-op。 */
  removeInflightAsk(id: string): void;
  listInflightAsks(): InflightAsk[];
}

/**
 * /ask 回答の公開共有 1 件の記録(ADR-0040)。1 回答 1 回まで(queryId が主キー)。
 * 投稿の前に「予約」として入れ(messageId=null)、投稿できたら messageId を埋める。
 * 投稿に失敗したら予約を消す。質問・回答の本文は持たない(queries 側にある)。
 */
export interface SharedAnswer {
  queryId: string;
  /** 予約時刻(ISO 8601 JST)。 */
  sharedAt: string;
  /** 投稿先チャンネル ID。 */
  channelId: string;
  /** 投稿したメッセージ ID(先頭チャンク)。投稿中・投稿途中で落ちた予約は null。 */
  messageId: string | null;
  /** 共有操作をした Discord ユーザー ID(= 質問者本人)。 */
  sharedBy: string;
}

/** 回答の共有記録(BotStore とは別の口。bot 本体だけが使う・ADR-0040)。 */
export interface SharedAnswerStore {
  /** 共有を予約する。既に記録があれば false(何も変えない)。 */
  claimSharedAnswer(row: Omit<SharedAnswer, "messageId">): boolean;
  /** 投稿できたメッセージ ID を記録する。未知 id は no-op。 */
  completeSharedAnswer(queryId: string, messageId: string): void;
  /** 投稿できなかった予約を消す(messageId が未記録の行だけ)。 */
  releaseSharedAnswer(queryId: string): void;
  getSharedAnswer(queryId: string): SharedAnswer | undefined;
}

/** bot が all_visible の列挙由来(managed)として作った clone dir の記録(ADR-0036 D4)。 */
export interface ManagedClone {
  /** CLONES_DIR 直下の dir 名(1 セグメント)。 */
  dir: string;
  /** "org/name"(観測用)。 */
  repo: string;
  /** 記録時刻(ISO 8601 JST・§7.5)。 */
  createdAt: string;
}

/**
 * managed clone の記録(ADR-0036 D4。BotStore とは別の口。bot 本体だけが使う)。
 * 対象外になったリポの clone を消してよいのは、ここに記録がある(= bot が作った)dir だけ。
 */
export interface ManagedCloneStore {
  /** dir 昇順。 */
  listManagedClones(): ManagedClone[];
  /** 記録する(同じ dir は冪等。最初の createdAt を保つ)。 */
  addManagedClone(c: ManagedClone): void;
  /** 記録を消す(未知 dir は no-op)。 */
  removeManagedClone(dir: string): void;
}

/** インメモリ実装(テスト/開発用。native 依存なし)。プロセス終了で消える。 */
export function createMemoryStore(): BotStore &
  InflightAskStore &
  SharedAnswerStore &
  ManagedCloneStore {
  const inflight = new Map<string, InflightAsk>();
  const shared = new Map<string, SharedAnswer>();
  const managed = new Map<string, ManagedClone>();
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
    setFeedback(id, value) {
      const q = queries.find((row) => row.id === id);
      if (q) q.feedback = value;
    },
    queueAction(a) {
      actions.push({ ...a });
    },
    listPendingActions(type) {
      return actions.filter((a) => type === undefined || a.type === type);
    },
    markActionDone(id) {
      const a = actions.find((row) => row.id === id);
      if (a) a.state = "done";
    },
    setActionState(id, state) {
      const a = actions.find((row) => row.id === id);
      if (a) a.state = state;
    },
    setActionPayload(id, payloadJson) {
      const a = actions.find((row) => row.id === id);
      if (a) a.payloadJson = payloadJson;
    },
    hitRateLimit(subject, kind, windowStart, limit) {
      const key = `${subject}|${kind}|${windowStart}`;
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return { count, allowed: count <= limit };
    },
    addInflightAsk(row) {
      inflight.set(row.id, { ...row });
    },
    removeInflightAsk(id) {
      inflight.delete(id);
    },
    listInflightAsks() {
      return [...inflight.values()].map((r) => ({ ...r }));
    },
    claimSharedAnswer(row) {
      if (shared.has(row.queryId)) return false;
      shared.set(row.queryId, { ...row, messageId: null });
      return true;
    },
    completeSharedAnswer(queryId, messageId) {
      const r = shared.get(queryId);
      if (r) r.messageId = messageId;
    },
    releaseSharedAnswer(queryId) {
      if (shared.get(queryId)?.messageId === null) shared.delete(queryId);
    },
    getSharedAnswer(queryId) {
      const r = shared.get(queryId);
      return r === undefined ? undefined : { ...r };
    },
    listManagedClones() {
      return [...managed.values()]
        .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
        .map((c) => ({ ...c }));
    },
    addManagedClone(c) {
      const prev = managed.get(c.dir);
      managed.set(c.dir, { ...c, createdAt: prev?.createdAt ?? c.createdAt });
    },
    removeManagedClone(dir) {
      managed.delete(dir);
    },
    close() {},
  };
}
