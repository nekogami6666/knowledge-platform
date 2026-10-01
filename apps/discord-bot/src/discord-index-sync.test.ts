import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { type DiscordIndexConfig, discordIndexConfigSchema } from "./config.js";
import type { DiscordIndexStore } from "./discord-index-store.js";
import {
  createDiscordIndexSync,
  type DiscordIndexSource,
  type SourceChannel,
  type SourceGuild,
  type SourceMessage,
} from "./discord-index-sync.js";
import { snowflakeForMs } from "./snowflake.js";

function sqliteAvailable(): boolean {
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      path: string,
    ) => { close(): void };
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1, 3, 0, 0);

let seq = 0;
/** 作成時刻と整合する snowflake を持つメッセージ。 */
function m(channelId: string, agoMs: number, content: string, over: Partial<SourceMessage> = {}) {
  seq += 1;
  const createdAt = NOW - agoMs;
  const id = (BigInt(snowflakeForMs(createdAt)) + BigInt(seq)).toString();
  const msg: SourceMessage = {
    id,
    guildId: "g1",
    channelId,
    authorId: "u1",
    authorName: "山田",
    authorIsBot: false,
    content,
    createdAt,
    editedAt: null,
    url: `https://discord.com/channels/g1/${channelId}/${id}`,
    ...over,
  };
  return msg;
}

function text(id: string, over: Partial<SourceChannel> = {}): SourceChannel {
  return {
    id,
    guildId: "g1",
    name: `ch-${id}`,
    kind: "text",
    parentChannelId: id,
    gate: { channelId: id, parentId: "cat", botCanView: true },
    parentGate: null,
    ...over,
  };
}

function thread(id: string, parent: string, over: Partial<SourceChannel> = {}): SourceChannel {
  return {
    id,
    guildId: "g1",
    name: `th-${id}`,
    kind: "thread",
    parentChannelId: parent,
    gate: { channelId: id, parentId: parent, botCanView: true },
    parentGate: { channelId: parent, parentId: "cat", botCanView: true },
    ...over,
  };
}

/** Discord 側の fake。messages は「今 Discord にある状態」。 */
class FakeSource implements DiscordIndexSource {
  guilds: SourceGuild[] = [{ id: "g1", available: true }];
  channels: SourceChannel[] = [];
  messages = new Map<string, SourceMessage[]>();
  calls: { channelId: string; afterId: string; cap: number }[] = [];
  /** fetch の途中で起きる出来事(ライブイベントとの競合の再現用)。 */
  duringFetch: (() => void) | undefined;

  listGuilds() {
    return this.guilds;
  }
  async listChannels(_guildId: string, opts: { includeThreads: boolean }) {
    return this.channels.filter((c) => opts.includeThreads || c.kind !== "thread");
  }
  async fetchMessagesAfter(channelId: string, afterId: string, cap: number) {
    this.calls.push({ channelId, afterId, cap });
    const all = (this.messages.get(channelId) ?? [])
      .filter((x) => BigInt(x.id) > BigInt(afterId))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .slice(0, cap);
    this.duringFetch?.();
    return all;
  }
  put(...msgs: SourceMessage[]) {
    for (const x of msgs) {
      const list = this.messages.get(x.channelId) ?? [];
      const i = list.findIndex((y) => y.id === x.id);
      if (i >= 0) list[i] = x;
      else list.push(x);
      this.messages.set(x.channelId, list);
    }
  }
  remove(channelId: string, id: string) {
    this.messages.set(
      channelId,
      (this.messages.get(channelId) ?? []).filter((x) => x.id !== id),
    );
  }
}

const baseConfig = (over: Partial<DiscordIndexConfig> = {}): DiscordIndexConfig => ({
  ...discordIndexConfigSchema.parse({ enabled: true }),
  ...over,
});

describe.skipIf(!sqliteAvailable())("createDiscordIndexSync(ADR-0038 D3/D4)", () => {
  let store: DiscordIndexStore;
  let source: FakeSource;
  let now: number;

  beforeEach(async () => {
    const { createDiscordIndexStore } = await import("./discord-index-store.js");
    store = createDiscordIndexStore(":memory:");
    source = new FakeSource();
    now = NOW;
  });

  const make = (opts: { exclude?: string[]; config?: Partial<DiscordIndexConfig> } = {}) =>
    createDiscordIndexSync({
      store,
      source,
      channels: { permanent_exclude: opts.exclude ?? [] },
      config: baseConfig(opts.config),
      now: () => now,
    });

  /** 親チャンネル集合にある全本文(LIKE '%%' で全件)。 */
  const all = (parents: string[]) =>
    store
      .search({ ftsTerms: [], likeTerms: [""], parentChannelIds: parents, limit: 100 })
      .map((h) => h.content)
      .sort();

  it("初回は backfill_days から取り込み、bot・webhook・空本文は保存しない", async () => {
    source.channels = [text("c1")];
    source.put(
      m("c1", 100 * DAY, "backfill より古い"),
      m("c1", 2 * DAY, "人間の発言"),
      m("c1", DAY, "bot の発言", { authorIsBot: true }),
      m("c1", DAY / 2, "   "),
    );
    const report = await make().runCycle();
    expect(source.calls[0]?.afterId).toBe(snowflakeForMs(NOW - 90 * DAY));
    expect(all(["c1"])).toEqual(["人間の発言"]);
    expect(report?.upserted).toBe(1);
    expect(store.getCursor("c1").caughtUp).toBe(true);
  });

  it("差分同期: 2 回目は直近の照合範囲(7 日)から取り直し、新規だけ増える", async () => {
    source.channels = [text("c1")];
    source.put(m("c1", 20 * DAY, "古い発言"), m("c1", 3 * DAY, "3 日前"));
    const sync = make();
    await sync.runCycle();
    source.put(m("c1", DAY, "昨日"));
    now = NOW + 60_000;
    await sync.runCycle();
    expect(source.calls[1]?.afterId).toBe(snowflakeForMs(now - 7 * DAY));
    expect(all(["c1"])).toEqual(["3 日前", "古い発言", "昨日"]);
  });

  it("permanent_exclude のチャンネル・そのスレッドは保存しない(ライブでも同期でも)", async () => {
    const ex = text("secret");
    const exThread = thread("t1", "secret");
    source.channels = [text("c1"), ex, exThread];
    source.put(m("secret", DAY, "人事の話"), m("t1", DAY, "スレッドの人事の話"));
    const sync = make({ exclude: ["secret"] });
    await sync.runCycle();
    sync.handleMessage(m("secret", 0, "ライブの人事の話"), ex);
    sync.handleMessage(m("t1", 0, "ライブのスレッドの話"), exThread);
    expect(store.counts().messages).toBe(0);
    expect(source.calls.map((c) => c.channelId)).toEqual(["c1"]);
  });

  it("カテゴリが permanent_exclude ならその下のチャンネルのスレッドも保存しない(親のゲートも見る)", async () => {
    const c = text("c1", { gate: { channelId: "c1", parentId: "hrcat", botCanView: true } });
    const t = thread("t1", "c1", {
      parentGate: { channelId: "c1", parentId: "hrcat", botCanView: true },
    });
    const sync = make({ exclude: ["hrcat"] });
    sync.handleMessage(m("c1", 0, "a"), c);
    sync.handleMessage(m("t1", 0, "b"), t);
    expect(store.counts().messages).toBe(0);
  });

  it("bot に見えない・親が未キャッシュ(判定不能)のスレッドは保存しない", () => {
    const sync = make();
    sync.handleMessage(
      m("c9", 0, "見えない"),
      text("c9", { gate: { channelId: "c9", parentId: null, botCanView: false } }),
    );
    sync.handleMessage(
      m("t9", 0, "親不明"),
      thread("t9", "c1", { parentGate: { channelId: "c1", parentId: null, botCanView: null } }),
    );
    expect(store.counts().messages).toBe(0);
  });

  it("ライブの編集は反映され、同期中の古い取得結果で巻き戻らない", async () => {
    const c1 = text("c1");
    source.channels = [c1];
    const orig = m("c1", DAY, "編集前");
    source.put(orig);
    const sync = make();
    await sync.runCycle();
    const edited = { ...orig, content: "編集後", editedAt: NOW + 1000 };
    // 照合の取得(編集前を返す)の最中にライブの編集が届く。
    source.duringFetch = () => sync.handleMessage(edited, c1);
    now = NOW + 2000;
    await sync.runCycle();
    expect(all(["c1"])).toEqual(["編集後"]);
    // 編集で空本文になったら消える。
    source.duringFetch = undefined;
    sync.handleMessage({ ...orig, content: "", editedAt: NOW + 3000 }, c1);
    expect(store.counts().messages).toBe(0);
  });

  it("ライブの削除・一括削除は即時に消え、同期中の古い取得結果で復活しない", async () => {
    const c1 = text("c1");
    source.channels = [c1];
    const a = m("c1", DAY, "消す A");
    const b = m("c1", DAY, "消す B");
    const c = m("c1", DAY, "残す C");
    source.put(a, b, c);
    const sync = make();
    await sync.runCycle();
    sync.handleDelete([a.id]);
    expect(all(["c1"])).toEqual(["残す C", "消す B"]);
    // 次の照合の取得には B がまだ載っているが、取得の最中に一括削除が届く。
    source.duringFetch = () => sync.handleDelete([b.id]);
    now = NOW + 1000;
    await sync.runCycle();
    expect(all(["c1"])).toEqual(["残す C"]);
  });

  it("停止中の削除・編集は定期照合で反映し、取得開始後に作られた新規は消さない", async () => {
    const c1 = text("c1");
    source.channels = [c1];
    const gone = m("c1", 2 * DAY, "停止中に消される");
    const edit = m("c1", 2 * DAY, "停止中に編集される");
    source.put(gone, edit);
    const sync = make();
    await sync.runCycle();
    // 停止中の変化(イベントは届かない)。
    source.remove("c1", gone.id);
    source.put({ ...edit, content: "編集済み", editedAt: NOW + 10 });
    now = NOW + 6 * 3_600_000;
    // 取得の最中に(取得開始より後の時刻で)ライブの新規が届く。
    const fresh = m("c1", -7 * 3_600_000, "取得中の新規");
    source.duringFetch = () => sync.handleMessage(fresh, c1);
    await sync.runCycle();
    expect(all(["c1"])).toEqual(["取得中の新規", "編集済み"]);
  });

  it("照合範囲より古い本文は照合で消さない(取得範囲外)", async () => {
    source.channels = [text("c1")];
    const old = m("c1", 30 * DAY, "30 日前");
    source.put(old);
    const sync = make();
    await sync.runCycle();
    source.remove("c1", old.id); // 30 日前の削除は照合範囲(7 日)外
    now = NOW + 1000;
    await sync.runCycle();
    expect(all(["c1"])).toEqual(["30 日前"]);
  });

  it("bot が見えなくなったチャンネルの本文は ChannelUpdate・再評価・定期同期で消える", async () => {
    source.channels = [text("c1"), text("c2"), thread("t2", "c2")];
    source.put(m("c1", DAY, "c1 の本文"), m("c2", DAY, "c2 の本文"), m("t2", DAY, "t2 の本文"));
    const sync = make();
    await sync.runCycle();
    expect(store.counts().messages).toBe(3);

    // ChannelUpdate: 親 c2 が見えなくなる → スレッドの本文も消える。
    const hidden = text("c2", { gate: { channelId: "c2", parentId: "cat", botCanView: false } });
    sync.handleChannelChanged(hidden);
    expect(all(["c1", "c2"])).toEqual(["c1 の本文"]);

    // GuildRoleUpdate 等の再評価: キャッシュ上で c1 が見えなくなっている。
    source.channels = [
      text("c1", { gate: { channelId: "c1", parentId: "cat", botCanView: false } }),
    ];
    expect(await sync.refreshVisibility()).toBe(1);
    expect(store.counts().messages).toBe(0);
  });

  it("ThreadDelete・ChannelDelete で本文を消す", async () => {
    source.channels = [text("c1"), thread("t1", "c1")];
    source.put(m("c1", DAY, "親"), m("t1", DAY, "スレッド"));
    const sync = make();
    await sync.runCycle();
    sync.handleChannelGone("t1");
    expect(all(["c1"])).toEqual(["親"]);
    sync.handleChannelGone("c1");
    expect(store.counts().messages).toBe(0);
  });

  it("unavailable なギルドは消さない・一覧に無い(bot が外れた)ギルドは消す", async () => {
    source.channels = [text("c1")];
    source.put(m("c1", DAY, "本文"));
    const sync = make();
    await sync.runCycle();
    source.guilds = [{ id: "g1", available: false }];
    source.channels = [];
    await sync.runCycle();
    expect(store.counts().messages).toBe(1);
    source.guilds = [];
    await sync.runCycle();
    expect(store.counts().messages).toBe(0);
  });

  it("保持期間を過ぎた本文は同期のたびに消える", async () => {
    source.channels = [text("c1")];
    source.put(m("c1", 80 * DAY, "80 日前"), m("c1", DAY, "昨日"));
    const sync = make({ config: { retention_days: 90, backfill_days: 90 } });
    await sync.runCycle();
    now = NOW + 15 * DAY;
    await sync.runCycle();
    expect(all(["c1"])).toEqual(["昨日"]);
  });

  it("取得が上限で打ち切られたら、追いつくまで照合せずカーソルから続きを取る", async () => {
    source.channels = [text("c1")];
    for (let i = 0; i < 5; i++) source.put(m("c1", (20 - i) * DAY, `m${i}`));
    const sync = make({ config: { max_fetch_per_channel: 2 } });
    const r1 = await sync.runCycle();
    expect(r1?.cappedChannels).toBe(1);
    const cursor1 = store.getCursor("c1");
    expect(cursor1.caughtUp).toBe(false);
    await sync.runCycle();
    expect(source.calls[1]?.afterId).toBe(cursor1.lastMessageId);
    await sync.runCycle();
    expect(all(["c1"])).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(store.getCursor("c1").caughtUp).toBe(true);
  });

  it("多重起動しない(実行中の runCycle があれば null)", async () => {
    source.channels = [text("c1")];
    const sync = make();
    const [a, b] = await Promise.all([sync.runCycle(), sync.runCycle()]);
    expect([a === null, b === null].sort()).toEqual([false, true]);
  });
});
