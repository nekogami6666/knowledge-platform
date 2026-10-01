/**
 * Discord 本文インデックス(ADR-0038 D3)の discord.js 配線。discord.js のオブジェクトを
 * discord-index-sync.ts の純粋データへ変換し、イベントを購読する。判定ロジックは sync 側(単体テスト)で、
 * 本ファイルは変換とグルー(CLAUDE.md §12.2)。
 *
 * - 対象: ギルドの通常・アナウンスチャンネル、その公開スレッド(アナウンススレッド・フォーラム投稿を含む)。
 *   フォーラム / メディアチャンネルはスレッドの親としてだけ扱う。private thread・VC 内蔵チャット・DM は対象外。
 * - intents は既存の Guilds / GuildMessages / MessageContent で足りる(BOT_INTENTS)。
 * - Partials.Message(BOT_PARTIALS)があるため、未キャッシュのメッセージの削除・編集も届く。
 */
import {
  type Channel,
  ChannelType,
  type Client,
  Events,
  type Message,
  type PartialMessage,
} from "discord.js";
import { paginateAfter } from "./collector-session.js";
import type {
  DiscordIndexSource,
  DiscordIndexSync,
  SourceChannel,
  SourceMessage,
  SyncLogger,
} from "./discord-index-sync.js";
import { gateInputFromChannel } from "./visibility.js";

/** discord.js のチャンネル → 同期対象の純粋データ(対象外の種別は null)。 */
export function sourceChannelFromDiscord(ch: Channel): SourceChannel | null {
  if (ch.isDMBased()) return null;
  switch (ch.type) {
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
      return {
        id: ch.id,
        guildId: ch.guildId,
        name: ch.name,
        kind: "text",
        parentChannelId: ch.id,
        gate: gateInputFromChannel(ch, ch.id),
        parentGate: null,
      };
    case ChannelType.GuildForum:
    case ChannelType.GuildMedia:
      return {
        id: ch.id,
        guildId: ch.guildId,
        name: ch.name,
        kind: "forum",
        parentChannelId: ch.id,
        gate: gateInputFromChannel(ch, ch.id),
        parentGate: null,
      };
    case ChannelType.PublicThread:
    case ChannelType.AnnouncementThread: {
      const parentId = ch.parentId;
      if (parentId === null) return null;
      const parent = ch.parent;
      return {
        id: ch.id,
        guildId: ch.guildId,
        name: ch.name,
        kind: "thread",
        parentChannelId: parentId,
        gate: gateInputFromChannel(ch, ch.id),
        // 親が未キャッシュなら判定不能(botCanView: null)= 保存しない(ADR-0018 D2 の安全側)。
        parentGate:
          parent !== null
            ? gateInputFromChannel(parent, parent.id)
            : { channelId: parentId, parentId: null, botCanView: null },
      };
    }
    default:
      // PrivateThread(参加者を判定できない・ADR-0038 D4)・VC・ステージ・カテゴリ等。
      return null;
  }
}

/** discord.js のメッセージ → 純粋データ(ギルドのメッセージ前提)。 */
export function sourceMessageFromDiscord(m: Message<true>): SourceMessage {
  return {
    id: m.id,
    guildId: m.guildId,
    channelId: m.channelId,
    authorId: m.author.id,
    authorName: m.member?.displayName ?? m.author.displayName ?? m.author.username,
    authorIsBot: m.author.bot || m.webhookId !== null || m.system,
    content: m.content,
    createdAt: m.createdTimestamp,
    editedAt: m.editedTimestamp,
    url: m.url,
  };
}

/** REST・キャッシュを使う {@link DiscordIndexSource} の実装。 */
export function createDiscordIndexSource(client: Client): DiscordIndexSource {
  return {
    listGuilds() {
      return [...client.guilds.cache.values()].map((g) => ({ id: g.id, available: g.available }));
    },
    async listChannels(guildId, opts) {
      const guild = client.guilds.cache.get(guildId);
      if (guild === undefined) return [];
      const seen = new Map<string, SourceChannel>();
      for (const ch of guild.channels.cache.values()) {
        if (ch.isThread()) continue; // スレッドは下でアクティブ一覧から取る
        const sc = sourceChannelFromDiscord(ch);
        if (sc !== null) seen.set(sc.id, sc);
      }
      if (opts.includeThreads) {
        const active = await guild.channels.fetchActiveThreads();
        for (const t of active.threads.values()) {
          const sc = sourceChannelFromDiscord(t);
          if (sc !== null) seen.set(sc.id, sc);
        }
      }
      return [...seen.values()];
    },
    async fetchMessagesAfter(channelId, afterId, cap) {
      const ch = await client.channels.fetch(channelId);
      if (ch === null || !ch.isTextBased() || ch.isDMBased()) return [];
      return paginateAfter<SourceMessage>(
        async (cursor, limit) => {
          const batch = await ch.messages.fetch({
            limit,
            ...(cursor !== null ? { after: cursor } : {}),
          });
          // Discord は新しい順で返す → snowflake 昇順(oldest-first)に並べ替える。
          return [...batch.values()]
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
            .map((m) => sourceMessageFromDiscord(m as Message<true>));
        },
        afterId,
        cap,
      );
    },
  };
}

/** 可視性の再評価をまとめる間隔(ロール変更は連続で届くことが多い)。 */
const VISIBILITY_DEBOUNCE_MS = 5_000;

/**
 * イベントを購読する。ハンドラは例外を外へ出さない(bot 本体を落とさない)。
 * 本文はログに出さない。
 */
export function attachDiscordIndexListeners(
  client: Client,
  sync: DiscordIndexSync,
  logger: SyncLogger,
): void {
  const guard =
    <A extends unknown[]>(what: string, fn: (...args: A) => void | Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await fn(...args);
      } catch (err) {
        logger.warn({ err }, `discord-index: ${what} の処理に失敗しました`);
      }
    };

  const onMessage = (m: Message): void => {
    if (!m.inGuild()) return;
    const ch = sourceChannelFromDiscord(m.channel);
    if (ch === null) return;
    sync.handleMessage(sourceMessageFromDiscord(m), ch);
  };

  client.on(Events.MessageCreate, guard("MessageCreate", onMessage));
  client.on(
    Events.MessageUpdate,
    guard("MessageUpdate", async (_old, updated: Message | PartialMessage) => {
      // 未キャッシュのメッセージの編集は partial で届くことがある → 取り直す(失敗は次の照合に任せる)。
      const m = updated.partial ? await updated.fetch().catch(() => null) : updated;
      if (m !== null) onMessage(m);
    }),
  );
  client.on(
    Events.MessageDelete,
    guard("MessageDelete", (m) => sync.handleDelete([m.id])),
  );
  client.on(
    Events.MessageBulkDelete,
    guard("MessageBulkDelete", (msgs) => sync.handleDelete([...msgs.keys()])),
  );
  client.on(
    Events.ThreadCreate,
    guard("ThreadCreate", (t) => {
      const ch = sourceChannelFromDiscord(t);
      if (ch !== null) sync.handleChannelChanged(ch);
    }),
  );
  client.on(
    Events.ThreadDelete,
    guard("ThreadDelete", (t) => sync.handleChannelGone(t.id)),
  );
  client.on(
    Events.ChannelDelete,
    guard("ChannelDelete", (c) => sync.handleChannelGone(c.id)),
  );
  client.on(
    Events.ChannelUpdate,
    guard("ChannelUpdate", (_old, c) => {
      const ch = sourceChannelFromDiscord(c);
      // 対象外の種別へ変わった場合も含め、同期対象として扱えないなら本文を消す。
      if (ch === null) sync.handleChannelGone(c.id);
      else sync.handleChannelChanged(ch);
    }),
  );

  // ロール・bot 自身のロールの変更は、どのチャンネルが見えるかを変えうる → まとめて再評価する。
  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void sync.refreshVisibility().catch((err: unknown) => {
        logger.warn({ err }, "discord-index: 可視性の再評価に失敗しました");
      });
    }, VISIBILITY_DEBOUNCE_MS);
    timer.unref();
  };
  client.on(Events.GuildRoleUpdate, () => scheduleRefresh());
  client.on(Events.GuildRoleDelete, () => scheduleRefresh());
  client.on(Events.GuildMemberUpdate, (_old, member) => {
    if (member.id === client.user?.id) scheduleRefresh();
  });
}
