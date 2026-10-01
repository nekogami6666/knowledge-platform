import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import type { DiscordIndexStore, IndexedMessage } from "./discord-index-store.js";

/**
 * better-sqlite3 の native バイナリが無い環境では skip する(sqlite-store.test.ts と同じ判定)。
 * ストアは describe 内で lazy import する(静的 import は native ロードでクラッシュするため)。
 */
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

const T0 = Date.UTC(2026, 8, 1);

function msg(over: Partial<IndexedMessage> & { messageId: string }): IndexedMessage {
  return {
    guildId: "g1",
    channelId: "c1",
    parentChannelId: "c1",
    threadId: null,
    authorId: "u1",
    authorName: "山田",
    createdAt: T0,
    editedAt: null,
    content: "本文",
    permalink: `https://discord.com/channels/g1/c1/${over.messageId}`,
    ...over,
  };
}

describe.skipIf(!sqliteAvailable())("createDiscordIndexStore(ADR-0038 D2)", () => {
  let store: DiscordIndexStore;
  beforeEach(async () => {
    const { createDiscordIndexStore } = await import("./discord-index-store.js");
    store = createDiscordIndexStore(":memory:");
  });

  const search = (terms: { fts?: string[]; like?: string[] }, parents = ["c1"], extra = {}) =>
    store.search({
      ftsTerms: terms.fts ?? [],
      likeTerms: terms.like ?? [],
      parentChannelIds: parents,
      limit: 20,
      ...extra,
    });

  it("upsert: 挿入・同一なら unchanged・編集で更新・古い版は stale で捨てる", () => {
    expect(store.upsertMessage(msg({ messageId: "1", content: "デプロイ手順" }))).toBe("inserted");
    expect(store.upsertMessage(msg({ messageId: "1", content: "デプロイ手順" }))).toBe("unchanged");
    expect(
      store.upsertMessage(msg({ messageId: "1", content: "リリース手順", editedAt: T0 + 10 })),
    ).toBe("updated");
    // 編集前の版(同期中に取った古い結果)で巻き戻さない。
    expect(store.upsertMessage(msg({ messageId: "1", content: "デプロイ手順" }))).toBe("stale");
    expect(search({ fts: ["リリース"] }).map((h) => h.content)).toEqual(["リリース手順"]);
    // FTS も更新トリガで追随する(旧本文の語では当たらない)。
    expect(search({ fts: ["デプロイ"] })).toEqual([]);
  });

  it("削除は FTS からも消え、tombstone により古い取得結果で復活しない", () => {
    store.upsertMessage(msg({ messageId: "1", content: "障害対応の振り返り" }));
    expect(store.deleteMessages(["1"], T0)).toBe(1);
    expect(search({ fts: ["障害対応"] })).toEqual([]);
    expect(store.upsertMessage(msg({ messageId: "1", content: "障害対応の振り返り" }))).toBe(
      "tombstoned",
    );
    expect(store.counts().messages).toBe(0);
    // tombstone の期限が切れれば(新規 ID と同様に)入れられる。
    expect(store.pruneTombstones(T0 + 1)).toBe(1);
    expect(store.upsertMessage(msg({ messageId: "1", content: "障害対応の振り返り" }))).toBe(
      "inserted",
    );
  });

  it("FTS trigram は 3 文字以上・日本語の部分一致、1〜2 文字は LIKE で補う", () => {
    store.upsertMessage(msg({ messageId: "1", content: "勤怠システムの締め日を変更する" }));
    store.upsertMessage(msg({ messageId: "2", content: "DB のバックアップ設定" }));
    store.upsertMessage(msg({ messageId: "3", content: "勤怠の話ではない雑談" }));
    expect(search({ fts: ["システム"] }).map((h) => h.messageId)).toEqual(["1"]);
    // 2 文字は FTS では当たらない(trigram の制約)が LIKE で当たる。
    expect(search({ fts: ["勤怠"] })).toEqual([]);
    expect(
      search({ like: ["勤怠"] })
        .map((h) => h.messageId)
        .sort(),
    ).toEqual(["1", "3"]);
    expect(search({ like: ["db"] }).map((h) => h.messageId)).toEqual(["2"]); // 大小無視
    // FTS と LIKE の AND。
    expect(search({ fts: ["締め日"], like: ["勤怠"] }).map((h) => h.messageId)).toEqual(["1"]);
  });

  it("検索範囲外(親チャンネルが許可集合に無い)は返さない・空集合なら 0 件", () => {
    store.upsertMessage(msg({ messageId: "1", content: "秘密の議論です" }));
    store.upsertMessage(
      msg({
        messageId: "2",
        channelId: "t9",
        parentChannelId: "c2",
        threadId: "t9",
        content: "秘密の議論その2",
      }),
    );
    expect(search({ fts: ["秘密の"] }, ["c1"]).map((h) => h.messageId)).toEqual(["1"]);
    expect(search({ fts: ["秘密の"] }, ["c2"]).map((h) => h.messageId)).toEqual(["2"]);
    expect(search({ fts: ["秘密の"] }, [])).toEqual([]);
  });

  it("期間(since/until)と件数上限・LIKE のみは新しい順", () => {
    for (let i = 0; i < 5; i++) {
      store.upsertMessage(
        msg({ messageId: String(i + 1), content: `会議 ${i}`, createdAt: T0 + i }),
      );
    }
    expect(
      search({ like: ["会議"] }, ["c1"], { sinceMs: T0 + 1, untilMs: T0 + 3 }).map(
        (h) => h.messageId,
      ),
    ).toEqual(["4", "3", "2"]);
    expect(search({ like: ["会議"] }, ["c1"], { limit: 2 }).map((h) => h.messageId)).toEqual([
      "5",
      "4",
    ]);
  });

  it("検索語は FTS 構文・LIKE のワイルドカードとして解釈されない", () => {
    store.upsertMessage(msg({ messageId: "1", content: "100% 完了した" }));
    store.upsertMessage(msg({ messageId: "2", content: "1000 件完了" }));
    expect(search({ like: ["0%"] }).map((h) => h.messageId)).toEqual(["1"]);
    // FTS の演算子・列指定・引用符を含んでも例外にならず、フレーズとして扱う。
    expect(() => search({ fts: ['content:"x" OR *', "NEAR(a b)"] })).not.toThrow();
    expect(search({ fts: ["完了した"] }).map((h) => h.messageId)).toEqual(["1"]);
  });

  it("purgeChannel はスレッドごと消す・purgeGuildExcept は見えない親と除外を消す", () => {
    store.upsertMessage(msg({ messageId: "1" }));
    store.upsertMessage(
      msg({ messageId: "2", channelId: "t1", parentChannelId: "c1", threadId: "t1" }),
    );
    store.upsertMessage(msg({ messageId: "3", channelId: "c2", parentChannelId: "c2" }));
    store.upsertMessage(
      msg({ messageId: "4", channelId: "t2", parentChannelId: "c2", threadId: "t2" }),
    );
    store.upsertMessage(
      msg({ messageId: "5", guildId: "g2", channelId: "x", parentChannelId: "x" }),
    );
    expect(store.purgeChannel("c1")).toBe(2);
    // c2 は見える・スレッド t2 は除外 → 4 だけ消える。g2 は対象外(別ギルド)。
    expect(store.purgeGuildExcept("g1", new Set(["c2"]), new Set(["t2"]))).toBe(1);
    expect(store.counts().messages).toBe(2);
    expect(store.purgeGuildExcept("g1", new Set(), new Set())).toBe(1);
    expect(store.purgeGuildsNotIn(new Set(["g1"]))).toBe(1);
    expect(store.counts().messages).toBe(0);
  });

  it("purgeOlderThan は保持期間より古い本文を消す", () => {
    store.upsertMessage(msg({ messageId: "1", createdAt: T0 - 1 }));
    store.upsertMessage(msg({ messageId: "2", createdAt: T0 }));
    expect(store.purgeOlderThan(T0)).toBe(1);
    expect(store.counts().messages).toBe(1);
  });

  it("カーソルは snowflake の数値順で後退しない(桁数の違う ID でも)", () => {
    store.upsertChannel({
      channelId: "c1",
      guildId: "g1",
      parentChannelId: "c1",
      name: "dev",
      kind: "text",
    });
    expect(store.getCursor("c1")).toEqual({ lastMessageId: null, caughtUp: false });
    store.advanceCursor("c1", "99", true);
    store.advanceCursor("c1", "100", true);
    store.advanceCursor("c1", "98", false);
    expect(store.getCursor("c1")).toEqual({ lastMessageId: "100", caughtUp: false });
    store.advanceCursor("c1", null, true);
    expect(store.getCursor("c1")).toEqual({ lastMessageId: "100", caughtUp: true });
    expect(store.channelNames(["c1", "zz"])).toEqual(new Map([["c1", "dev"]]));
  });
});
