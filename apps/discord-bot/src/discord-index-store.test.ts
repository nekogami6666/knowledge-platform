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

  it("upsertMany: 1 トランザクションで upsert し、FTS・tombstone・古い版の規則は 1 件ずつと同じ", () => {
    store.upsertMessage(msg({ messageId: "1", content: "古い本文", editedAt: T0 + 10 }));
    store.deleteMessages(["2"], T0);
    expect(
      store.upsertMany([
        msg({ messageId: "1", content: "さらに古い取得結果" }), // edited_at が保存済みより古い
        msg({ messageId: "2", content: "削除済みの本文" }), // tombstone
        msg({ messageId: "3", content: "新しい障害対応メモ" }),
        msg({ messageId: "3", content: "新しい障害対応メモ" }),
      ]),
    ).toEqual(["stale", "tombstoned", "inserted", "unchanged"]);
    expect(store.upsertMany([])).toEqual([]);
    expect(search({ fts: ["障害対応"] }).map((h) => h.messageId)).toEqual(["3"]);
    expect(search({ fts: ["削除済み"] })).toEqual([]);
    expect(store.counts().messages).toBe(2);
  });

  it("upsertMany: 途中で失敗したら 1 件も書かない(トランザクション)", () => {
    const bad = { ...msg({ messageId: "2" }), content: null } as unknown as IndexedMessage;
    expect(() =>
      store.upsertMany([msg({ messageId: "1", content: "先に入る本文" }), bad]),
    ).toThrow();
    expect(store.counts().messages).toBe(0);
    expect(search({ fts: ["先に入る"] })).toEqual([]);
  });

  describe("searchAny(事前検索用の OR 検索・ADR-0038 追記 A3)", () => {
    const any = (terms: string[], parents = ["c1"], extra = {}) =>
      store.searchAny({ terms, parentChannelIds: parents, limit: 10, ...extra });

    it("3 文字以上の語の OR・一致した語の数(2 文字の語も数える)の多い順 → bm25 → 新しい順", () => {
      store.upsertMessage(
        msg({ messageId: "1", content: "勤怠システムの締め日は 25 日", createdAt: T0 }),
      );
      store.upsertMessage(
        msg({ messageId: "2", content: "勤怠システムの障害", createdAt: T0 + 1 }),
      );
      store.upsertMessage(msg({ messageId: "3", content: "締め日の連絡です", createdAt: T0 + 2 }));
      store.upsertMessage(msg({ messageId: "4", content: "関係ない雑談", createdAt: T0 + 3 }));
      const hits = any(["勤怠", "システム", "締め日"]);
      expect(hits.map((h) => [h.messageId, h.matchedTerms])).toEqual([
        ["1", 3],
        ["2", 2],
        ["3", 1],
      ]);
      for (const h of hits) expect(typeof h.bm25).toBe("number");
      // AND の search では 1 件しか当たらない(既存の挙動は変えない)。
      expect(search({ fts: ["システム", "締め日"] }).map((h) => h.messageId)).toEqual(["1"]);
    });

    it("一致数が同じなら bm25 → 新しい順・limit で切る", () => {
      store.upsertMessage(msg({ messageId: "1", content: "リリース", createdAt: T0 }));
      store.upsertMessage(msg({ messageId: "2", content: "リリース", createdAt: T0 + 1 }));
      store.upsertMessage(msg({ messageId: "3", content: "リリース", createdAt: T0 + 2 }));
      expect(any(["リリース"], ["c1"], { limit: 2 }).map((h) => h.messageId)).toEqual(["3", "2"]);
    });

    it("3 文字以上の語が無ければ LIKE の OR(bm25 は null)・大小無視・重複除去", () => {
      store.upsertMessage(msg({ messageId: "1", content: "DB の勤怠データ", createdAt: T0 }));
      store.upsertMessage(msg({ messageId: "2", content: "勤怠の話", createdAt: T0 + 1 }));
      store.upsertMessage(msg({ messageId: "3", content: "雑談", createdAt: T0 + 2 }));
      const hits = any(["db", "勤怠", "DB"]);
      expect(hits.map((h) => [h.messageId, h.matchedTerms, h.bm25])).toEqual([
        ["1", 2, null],
        ["2", 1, null],
      ]);
      expect(any([" ", ""])).toEqual([]);
    });

    it("検索範囲・期間は search と同じに絞る(範囲外の本文は返さない・空集合は 0 件)", () => {
      store.upsertMessage(msg({ messageId: "1", content: "秘密の議論です", createdAt: T0 }));
      store.upsertMessage(
        msg({
          messageId: "2",
          channelId: "t9",
          parentChannelId: "c2",
          threadId: "t9",
          content: "秘密の議論その2",
          createdAt: T0 + 5,
        }),
      );
      expect(any(["秘密の"], ["c1"]).map((h) => h.messageId)).toEqual(["1"]);
      expect(any(["秘密の"], ["c2"]).map((h) => h.messageId)).toEqual(["2"]);
      expect(any(["秘密の"], [])).toEqual([]);
      expect(any(["秘", "論"], ["c2"]).map((h) => h.messageId)).toEqual(["2"]);
      expect(any(["秘密の"], ["c1", "c2"], { sinceMs: T0 + 1 }).map((h) => h.messageId)).toEqual([
        "2",
      ]);
      expect(any(["秘密の"], ["c1", "c2"], { untilMs: T0 }).map((h) => h.messageId)).toEqual(["1"]);
    });

    it("語は FTS 構文・LIKE のワイルドカードとして解釈されない", () => {
      store.upsertMessage(msg({ messageId: "1", content: "100% 完了した" }));
      store.upsertMessage(msg({ messageId: "2", content: "1000 件完了" }));
      expect(() => any(['content:"x" OR *', "NEAR(a b)", "完了した"])).not.toThrow();
      expect(any(['content:"x" OR *', "完了した"]).map((h) => h.messageId)).toEqual(["1"]);
      expect(any(["0%"]).map((h) => h.messageId)).toEqual(["1"]);
    });
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
