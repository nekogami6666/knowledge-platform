/**
 * チャンネル履歴の収集セッション(ADR-0033 D5)。extractor の discord ソースが
 * `@stratum/discord-bot/collector` として使う短命 Gateway:
 * login(intents **[Guilds] のみ**・presence invisible)→ 可視テキストチャンネル列挙 →
 * REST ページング(after=snowflake・oldest-first)で履歴取得 → destroy。
 * discord.js 依存をこのパッケージに閉じ、可視性判定は visibility.ts(gateInputFromChannel)を
 * 再利用する。bot 本体と同一 token の第 2 セッションになるが、Guilds intent のみで interaction を
 * 受けず presence も invisible のため bot 運用に影響しない(ADR-0033 D5 の註記)。
 * 会話本文は呼び出し側が抽出後に破棄する(永続しない・ADR-0017 D7)。
 */
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import { gateInputFromChannel } from "./visibility.js";

/** 収集対象チャンネル(純粋データ)。 */
export interface CollectorChannel {
  id: string;
  name: string;
  parentId: string | null;
}

/** 収集メッセージ(純粋データ。discord.js 型は外に出さない)。 */
export interface CollectorMessageItem {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdAt: Date;
  /** 💡 リアクションが付いているか(capture 済み/されるはずの印 = デデュープ②)。 */
  hasLightbulb: boolean;
  /** permalink(https://discord.com/channels/<g>/<c>/<m>)。source の同一性キーに使う。 */
  url: string;
}

export interface CollectorSession {
  /** bot が読める(ViewChannel 実効)ギルドテキストチャンネル。スレッドは含まない(v1 スコープ外)。 */
  listReadableTextChannels(): CollectorChannel[];
  /**
   * afterId(snowflake・null = 先頭から)より後のメッセージを oldest-first で最大 cap 件。
   * Discord API の 1 ページ 100 件をページングして集める。
   */
  fetchMessagesAfter(
    channelId: string,
    afterId: string | null,
    cap: number,
  ): Promise<CollectorMessageItem[]>;
  close(): Promise<void>;
}

/**
 * 1 ページ分の取得関数(テスト seam)。oldest-first で返すこと。
 * 要素型は既定で CollectorMessageItem。Discord 本文インデックス(ADR-0038)も同じページングを使う。
 */
export type FetchPageFn<T extends { id: string } = CollectorMessageItem> = (
  afterId: string | null,
  limit: number,
) => Promise<T[]>;

/**
 * after カーソルでページを進めながら最大 cap 件を集める(純関数側・テスト対象)。
 * 終了条件: cap 到達 or ページが limit 未満(= 末尾到達)。
 */
export async function paginateAfter<T extends { id: string } = CollectorMessageItem>(
  fetchPage: FetchPageFn<T>,
  afterId: string | null,
  cap: number,
  pageSize = 100,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = afterId;
  while (out.length < cap) {
    const limit = Math.min(pageSize, cap - out.length);
    const page = await fetchPage(cursor, limit);
    out.push(...page);
    const last = page[page.length - 1];
    if (last === undefined || page.length < limit) break; // 末尾到達
    cursor = last.id;
  }
  return out;
}

/**
 * 実 Gateway セッションを開く。呼び出し側は必ず close() すること(プロセス常駐させない)。
 */
export async function openCollectorSession(opts: { token: string }): Promise<CollectorSession> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    presence: { status: "invisible" },
  });
  await client.login(opts.token);
  // ClientReady を待つ(guilds キャッシュが揃うまで)。
  if (!client.isReady()) {
    await new Promise<void>((resolve) => client.once("clientReady", () => resolve()));
  }

  return {
    listReadableTextChannels(): CollectorChannel[] {
      const channels: CollectorChannel[] = [];
      for (const guild of client.guilds.cache.values()) {
        for (const ch of guild.channels.cache.values()) {
          // ギルドの通常テキストチャンネルのみ(スレッド・VC 内蔵チャットは v1 対象外・ADR-0033 D9)。
          if (ch.type !== ChannelType.GuildText) continue;
          const gate = gateInputFromChannel(ch, ch.id);
          if (gate.botCanView !== true) continue;
          channels.push({ id: ch.id, name: ch.name, parentId: gate.parentId });
        }
      }
      return channels;
    },

    async fetchMessagesAfter(channelId, afterId, cap) {
      const ch = await client.channels.fetch(channelId);
      if (ch === null || !ch.isTextBased()) return [];
      const fetchPage: FetchPageFn = async (cursor, limit) => {
        const batch = await ch.messages.fetch({
          limit,
          ...(cursor !== null ? { after: cursor } : {}),
        });
        // Discord は新しい順で返す → snowflake(BigInt)昇順 = oldest-first に並べ替える。
        return [...batch.values()]
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
          .map((m) => ({
            id: m.id,
            authorId: m.author.id,
            authorName: m.author.displayName ?? m.author.username,
            authorIsBot: m.author.bot,
            content: m.content,
            createdAt: m.createdAt,
            hasLightbulb: m.reactions.cache.some((r) => r.emoji.name === "💡"),
            url: m.url,
          }));
      };
      return paginateAfter(fetchPage, afterId, cap);
    },

    async close() {
      await client.destroy();
    },
  };
}
