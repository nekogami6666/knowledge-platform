/**
 * Discord 本文インデックスの同期(ADR-0038 D3/D4)。discord.js には依存せず、Discord 側は
 * {@link DiscordIndexSource}(REST・キャッシュ)と、イベントで渡される純粋データだけを見る。
 * discord.js との変換・イベント購読は discord-index-discord.ts が担う。
 *
 * - 保存してよいのは isChannelAllowed(bot の実効 ViewChannel ∧ ¬permanent_exclude・スレッドは親でも照合)を
 *   満たすテキストチャンネル・公開スレッドだけ。スレッドは親チャンネルも同じ判定を通ること(D4)。
 *   bot・webhook・システムメッセージ、空本文は保存しない。
 * - カーソルは REST で連続取得できた位置だけを表す(ライブイベントでは進めない — 進めると停止中の
 *   取りこぼし区間を飛ばす)。
 * - 定期照合は直近 reconcile_window_days を取り直し、取得結果に無い保存済みメッセージを削除する。
 *   削除判定は「取得範囲の下端より後」かつ「取得開始時刻より前に作られた」ID に限る(取得中の新規を消さない)。
 * 本文はログに出さない(件数のみ・§7.4)。
 */
import {
  type ChannelGateInput,
  type ChannelsConfig,
  type DiscordIndexConfig,
  isChannelAllowed,
} from "./config.js";
import type { DiscordIndexStore, IndexedMessage } from "./discord-index-store.js";
import { compareSnowflake, snowflakeForMs, snowflakeToMs } from "./snowflake.js";

const DAY_MS = 86_400_000;
/** tombstone を残す期間(1 周期の取得より十分長ければよい)。 */
const TOMBSTONE_TTL_MS = DAY_MS;

/** Discord から取った 1 メッセージ(純粋データ)。 */
export interface SourceMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  /** bot・webhook・システムメッセージ(保存しない)。 */
  authorIsBot: boolean;
  content: string;
  createdAt: number;
  editedAt: number | null;
  url: string;
}

/** 同期対象になりうるチャンネル(純粋データ)。 */
export interface SourceChannel {
  id: string;
  guildId: string;
  name: string;
  /** text = 通常・アナウンス / forum = フォーラム等(本文は持たずスレッドの親になる)/ thread = 公開スレッド。 */
  kind: "text" | "forum" | "thread";
  /** スレッドなら親、それ以外は自分。 */
  parentChannelId: string;
  /** このチャンネル自身のゲート入力(ADR-0018)。 */
  gate: ChannelGateInput;
  /** スレッドの親のゲート入力(スレッド以外・親不明は null)。 */
  parentGate: ChannelGateInput | null;
}

export interface SourceGuild {
  id: string;
  /** 障害等で unavailable のギルドは一覧が信用できないため、削除も取得もしない。 */
  available: boolean;
}

/** Discord 側の seam(実装は discord-index-discord.ts。テストは fake)。 */
export interface DiscordIndexSource {
  listGuilds(): SourceGuild[];
  /**
   * ギルドのチャンネル。includeThreads=false はキャッシュのみ(可視性の再評価用)、
   * true はアクティブな公開スレッドも含む(REST を伴いうる)。
   */
  listChannels(guildId: string, opts: { includeThreads: boolean }): Promise<SourceChannel[]>;
  /** afterId より後を oldest-first で最大 cap 件。 */
  fetchMessagesAfter(channelId: string, afterId: string, cap: number): Promise<SourceMessage[]>;
}

export interface SyncLogger {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
}

export interface DiscordIndexSyncDeps {
  store: DiscordIndexStore;
  source: DiscordIndexSource;
  channels: ChannelsConfig;
  config: DiscordIndexConfig;
  now?: () => number;
  logger?: SyncLogger;
}

export interface CycleReport {
  guilds: number;
  channels: number;
  fetched: number;
  upserted: number;
  deleted: number;
  purgedByVisibility: number;
  purgedByRetention: number;
  cappedChannels: number;
  failedChannels: number;
}

export interface DiscordIndexSync {
  /** MessageCreate / MessageUpdate。対象外(編集で空本文になった等)なら削除する。 */
  handleMessage(msg: SourceMessage, channel: SourceChannel): void;
  /** MessageDelete / MessageBulkDelete(判定なしで常に削除)。 */
  handleDelete(messageIds: readonly string[]): void;
  /** ThreadDelete / ChannelDelete。 */
  handleChannelGone(channelId: string): void;
  /** ChannelUpdate / ThreadCreate。見えなくなったら削除、見えるならメタデータを更新。 */
  handleChannelChanged(channel: SourceChannel): void;
  /** GuildRoleUpdate 等: 全ギルドの可視性を再評価して、見えなくなったチャンネルの本文を消す。 */
  refreshVisibility(): Promise<number>;
  /** 起動時・定期: 可視性の再評価 → 取り込み + 照合 → 保持期間の削除。多重起動しない(実行中なら null)。 */
  runCycle(): Promise<CycleReport | null>;
}

/** チャンネルが保存対象か(D4)。スレッドは自身と親の両方が通ること。 */
export function isIndexableChannel(ch: SourceChannel, channels: ChannelsConfig): boolean {
  if (!isChannelAllowed(channels, ch.gate)) return false;
  if (ch.kind !== "thread") return true;
  return ch.parentGate !== null && isChannelAllowed(channels, ch.parentGate);
}

/** メッセージが保存対象か(bot・webhook・システム・空本文を除く)。 */
export function isIndexableMessage(m: SourceMessage): boolean {
  return !m.authorIsBot && m.content.trim().length > 0;
}

function toIndexed(m: SourceMessage, ch: SourceChannel): IndexedMessage {
  return {
    messageId: m.id,
    guildId: m.guildId,
    channelId: ch.id,
    parentChannelId: ch.parentChannelId,
    threadId: ch.kind === "thread" ? ch.id : null,
    authorId: m.authorId,
    authorName: m.authorName,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    content: m.content,
    permalink: m.url,
  };
}

const maxId = (a: string, b: string): string => (compareSnowflake(a, b) >= 0 ? a : b);
const minId = (a: string, b: string): string => (compareSnowflake(a, b) <= 0 ? a : b);

const noopLogger: SyncLogger = { info() {}, warn() {} };

export function createDiscordIndexSync(deps: DiscordIndexSyncDeps): DiscordIndexSync {
  const { store, source, channels, config } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? noopLogger;
  const excluded = new Set(channels.permanent_exclude);
  let running = false;

  /** 1 件を反映する(対象なら upsert、対象外なら削除)。戻りは upsert の有無。 */
  const apply = (m: SourceMessage, ch: SourceChannel): "upserted" | "deleted" | "none" => {
    if (!isIndexableChannel(ch, channels) || !isIndexableMessage(m)) {
      return store.deleteMessages([m.id], now()) > 0 ? "deleted" : "none";
    }
    const r = store.upsertMessage(toIndexed(m, ch));
    return r === "inserted" || r === "updated" ? "upserted" : "none";
  };

  const upsertChannelMeta = (ch: SourceChannel): void => {
    store.upsertChannel({
      channelId: ch.id,
      guildId: ch.guildId,
      parentChannelId: ch.parentChannelId,
      name: ch.name,
      kind: ch.kind,
    });
  };

  /**
   * ギルドの可視性を再評価して削除する。allowedParents はトップレベル(text/forum)の許可集合。
   * スレッドは親で消える(アーカイブ済みで一覧に無いスレッドの本文も、親が見える限り残す)。
   */
  const purgeGuild = (guildId: string, list: readonly SourceChannel[]): number => {
    const allowedParents = new Set(
      list.filter((c) => c.kind !== "thread" && isIndexableChannel(c, channels)).map((c) => c.id),
    );
    return store.purgeGuildExcept(guildId, allowedParents, excluded);
  };

  const syncChannel = async (ch: SourceChannel, report: CycleReport): Promise<void> => {
    const startedAt = now();
    const backfillAfter = snowflakeForMs(startedAt - config.backfill_days * DAY_MS);
    const windowAfter = maxId(
      snowflakeForMs(startedAt - config.reconcile_window_days * DAY_MS),
      backfillAfter,
    );
    const cursor = store.getCursor(ch.id);
    const start =
      cursor.lastMessageId === null ? backfillAfter : maxId(cursor.lastMessageId, backfillAfter);
    // 前回が上限で打ち切られていたら照合せずカーソルから続きを取る(追いつくまで照合を後回しにし、
    // 大量のチャンネルで同じ範囲を取り直し続けることを避ける)。
    const fetchFrom =
      cursor.caughtUp || cursor.lastMessageId === null ? minId(start, windowAfter) : start;
    const cap = config.max_fetch_per_channel;
    const msgs = await source.fetchMessagesAfter(ch.id, fetchFrom, cap);
    report.fetched += msgs.length;
    for (const m of msgs) {
      const r = apply(m, ch);
      if (r === "upserted") report.upserted += 1;
      else if (r === "deleted") report.deleted += 1;
    }
    const last = msgs[msgs.length - 1];
    const capped = msgs.length >= cap;
    if (capped) report.cappedChannels += 1;
    // 削除の照合: (fetchFrom, upper) の保存済み ID のうち、取得結果に無いもの。
    // 打ち切り時は最後に取得した ID まで(それより先は未確認)、そうでなければ取得開始時刻まで。
    const fetchedIds = new Set(msgs.map((m) => m.id));
    const upperExclusive = capped && last !== undefined ? null : snowflakeForMs(startedAt);
    const upperInclusive = capped && last !== undefined ? last.id : null;
    const candidates = store.listMessageIds(
      ch.id,
      snowflakeToMs(fetchFrom),
      upperInclusive !== null ? snowflakeToMs(upperInclusive) : startedAt,
    );
    const gone = candidates.filter(
      (id) =>
        !fetchedIds.has(id) &&
        compareSnowflake(id, fetchFrom) > 0 &&
        (upperInclusive !== null
          ? compareSnowflake(id, upperInclusive) <= 0
          : upperExclusive !== null && compareSnowflake(id, upperExclusive) < 0),
    );
    report.deleted += store.deleteMessages(gone, now());
    store.advanceCursor(ch.id, last?.id ?? null, !capped);
  };

  const safe = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.warn({ err }, `discord-index: ${what} に失敗しました`);
    }
  };

  return {
    handleMessage(msg, channel) {
      safe("メッセージの反映", () => {
        if (isIndexableChannel(channel, channels)) upsertChannelMeta(channel);
        apply(msg, channel);
      });
    },
    handleDelete(ids) {
      safe("削除の反映", () => {
        store.deleteMessages(ids, now());
      });
    },
    handleChannelGone(channelId) {
      safe("チャンネル削除の反映", () => {
        store.purgeChannel(channelId);
      });
    },
    handleChannelChanged(channel) {
      safe("チャンネル変更の反映", () => {
        if (isIndexableChannel(channel, channels)) upsertChannelMeta(channel);
        else {
          const n = store.purgeChannel(channel.id);
          if (n > 0) {
            log.info(
              { channelId: channel.id, purged: n },
              "discord-index: 対象外になったチャンネルの本文を削除しました",
            );
          }
        }
      });
    },
    async refreshVisibility() {
      let purged = 0;
      for (const g of source.listGuilds()) {
        if (!g.available) continue;
        try {
          const list = await source.listChannels(g.id, { includeThreads: false });
          purged += purgeGuild(g.id, list);
        } catch (err) {
          log.warn({ err, guildId: g.id }, "discord-index: 可視性の再評価に失敗しました");
        }
      }
      if (purged > 0) {
        log.info({ purged }, "discord-index: 見えなくなったチャンネルの本文を削除しました");
      }
      return purged;
    },
    async runCycle() {
      if (running) return null;
      running = true;
      const report: CycleReport = {
        guilds: 0,
        channels: 0,
        fetched: 0,
        upserted: 0,
        deleted: 0,
        purgedByVisibility: 0,
        purgedByRetention: 0,
        cappedChannels: 0,
        failedChannels: 0,
      };
      try {
        const guilds = source.listGuilds();
        // bot が外れたギルド(一覧に無い)の本文は消す。unavailable は一覧に残るので消さない。
        report.purgedByVisibility += store.purgeGuildsNotIn(new Set(guilds.map((g) => g.id)));
        for (const g of guilds) {
          if (!g.available) continue;
          report.guilds += 1;
          let list: SourceChannel[];
          try {
            list = await source.listChannels(g.id, { includeThreads: true });
          } catch (err) {
            log.warn({ err, guildId: g.id }, "discord-index: チャンネル一覧の取得に失敗しました");
            continue;
          }
          report.purgedByVisibility += purgeGuild(g.id, list);
          for (const ch of list) {
            if (!isIndexableChannel(ch, channels)) continue;
            upsertChannelMeta(ch);
            if (ch.kind === "forum") continue; // 本文はスレッド側
            report.channels += 1;
            try {
              await syncChannel(ch, report);
            } catch (err) {
              report.failedChannels += 1;
              log.warn({ err, channelId: ch.id }, "discord-index: チャンネルの同期に失敗しました");
            }
          }
        }
        const t = now();
        report.purgedByRetention = store.purgeOlderThan(t - config.retention_days * DAY_MS);
        store.pruneTombstones(t - TOMBSTONE_TTL_MS);
        log.info({ ...report, ...store.counts() }, "discord-index: 同期が完了しました");
        return report;
      } finally {
        running = false;
      }
    },
  };
}
