import { createRequire } from "node:module";
import type { PromptStore } from "@stratum/llm";
import { beforeEach, describe, expect, it } from "vitest";
import { type AskDeps, handleAskRequest, type QaSearchInput } from "./ask.js";
import { createMemoryStore } from "./db.js";
import type { DiscordIndexStore, IndexedMessage } from "./discord-index-store.js";
import {
  createDiscordSearchSession,
  excerpt,
  NO_CHANNEL_MESSAGE,
  NO_HIT_MESSAGE,
  overLimitMessage,
  parseDateBound,
  splitTerms,
} from "./discord-search-tool.js";

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

describe("discord_search の純関数", () => {
  it("splitTerms: 3 文字以上は FTS、1〜2 文字は LIKE(全角空白も区切り・重複除去)", () => {
    expect(splitTerms("勤怠 システム　締め日 勤怠")).toEqual({
      fts: ["システム", "締め日"],
      like: ["勤怠"],
    });
    expect(splitTerms("   ")).toEqual({ fts: [], like: [] });
  });

  it("parseDateBound: YYYY-MM-DD は JST の日の始まり/終わり、ISO はそのまま、不正は null", () => {
    expect(parseDateBound("2026-10-01", "start")).toBe(Date.parse("2026-10-01T00:00:00+09:00"));
    expect(parseDateBound("2026-10-01", "end")).toBe(Date.parse("2026-10-02T00:00:00+09:00") - 1);
    expect(parseDateBound("2026-10-01T12:00:00+09:00", "start")).toBe(
      Date.parse("2026-10-01T03:00:00Z"),
    );
    expect(parseDateBound("昨日", "start")).toBeNull();
  });

  it("excerpt: 一致した語の周辺を切り出し、切った側に … を付ける", () => {
    const body = `${"あ".repeat(500)}締め日は 25 日${"い".repeat(500)}`;
    const e = excerpt(body, ["締め日"], 100);
    expect([...e.replace(/…/g, "")].length).toBe(100);
    expect(e).toContain("締め日は 25 日");
    expect(e.startsWith("…") && e.endsWith("…")).toBe(true);
    expect(excerpt("短い本文", ["x"], 100)).toBe("短い本文");
  });
});

const T = Date.parse("2026-09-30T10:00:00+09:00");
/** テスト用のチャンネル名 → 数値 ID(permalink は数値のみ許可・§9.5)。 */
const NUM: Record<string, string> = { pub: "200", dev: "300", th: "400" };
function msg(id: string, parent: string, content: string, over: Partial<IndexedMessage> = {}) {
  const m: IndexedMessage = {
    messageId: id,
    guildId: "g1",
    channelId: parent,
    parentChannelId: parent,
    threadId: null,
    authorId: "u1",
    authorName: "山田",
    createdAt: T,
    editedAt: null,
    content,
    permalink: `https://discord.com/channels/100/${NUM[over.channelId ?? parent]}/${id}`,
    ...over,
  };
  return m;
}

describe.skipIf(!sqliteAvailable())("createDiscordSearchSession(ADR-0038 D5/D6)", () => {
  let store: DiscordIndexStore;
  beforeEach(async () => {
    const { createDiscordIndexStore } = await import("./discord-index-store.js");
    store = createDiscordIndexStore(":memory:");
    for (const [id, name] of [
      ["pub", "general"],
      ["dev", "dev-secret"],
    ] as const) {
      store.upsertChannel({
        channelId: id,
        guildId: "g1",
        parentChannelId: id,
        name,
        kind: "text",
      });
    }
    store.upsertChannel({
      channelId: "th",
      guildId: "g1",
      parentChannelId: "pub",
      name: "リリース相談",
      kind: "thread",
    });
    store.upsertMessage(msg("1", "pub", "勤怠システムの締め日は 25 日に変更"));
    store.upsertMessage(
      msg("2", "pub", "勤怠システムのリリースは来週", { channelId: "th", threadId: "th" }),
    );
    store.upsertMessage(msg("3", "dev", "勤怠システムの未公開の障害情報"));
  });

  const session = (channelIds: string[], maxToolCalls = 10) =>
    createDiscordSearchSession({
      store,
      scope: { guildId: "g1", channelIds: new Set(channelIds) },
      maxResults: 20,
      maxToolCalls,
    });

  it("質問者に見えないチャンネル(dev)の本文は返さない・返した permalink を記録する", async () => {
    const s = session(["pub"]);
    const tool = s.tools[0];
    if (tool === undefined) throw new Error("tool missing");
    const out = await tool.handler({ query: "勤怠システム" });
    expect(out).toContain("締め日は 25 日");
    expect(out).toContain("#general › リリース相談");
    expect(out).not.toContain("未公開の障害情報");
    expect(out).not.toContain("dev-secret");
    expect([...s.returnedPermalinks].sort()).toEqual([
      "https://discord.com/channels/100/200/1",
      "https://discord.com/channels/100/400/2",
    ]);
    expect(s.stats()).toMatchObject({ calls: 1, hits: 2, overLimit: 0 });
    expect(s.stats().ms).toBeGreaterThanOrEqual(0);
  });

  it("見えないチャンネルを channel で指定しても、存在しないチャンネルと同じ文面を返す", async () => {
    const tool = session(["pub"]).tools[0];
    if (tool === undefined) throw new Error("tool missing");
    expect(await tool.handler({ query: "勤怠システム", channel: "dev-secret" })).toBe(
      NO_CHANNEL_MESSAGE,
    );
    expect(await tool.handler({ query: "勤怠システム", channel: "no-such" })).toBe(
      NO_CHANNEL_MESSAGE,
    );
    expect(await tool.handler({ query: "締め日", channel: "#general" })).toContain("25 日");
    expect(await tool.handler({ query: "勤怠", since: "2026-10-01" })).toBe(NO_HIT_MESSAGE);
  });

  it("検索範囲が空ならツール自体を渡さない", () => {
    expect(session([]).tools).toEqual([]);
  });

  it("回数の上限(既定 1): 超えた呼び出しは検索せず定型文を返す・引数の誤りは数えない(ADR-0038 追記 A1)", async () => {
    let searched = 0;
    const counting: DiscordIndexStore = {
      ...store,
      search: (p) => {
        searched += 1;
        return store.search(p);
      },
    };
    const s = createDiscordSearchSession({
      store: counting,
      scope: { guildId: "g1", channelIds: new Set(["pub"]) },
      maxResults: 20,
    });
    const tool = s.tools[0];
    if (tool === undefined) throw new Error("tool missing");
    expect(tool.description).toContain("1 回まで");
    // 引数の誤り(解決できないチャンネル・日付の形式)は上限に数えない。
    expect(await tool.handler({ query: "勤怠システム", channel: "no-such" })).toBe(
      NO_CHANNEL_MESSAGE,
    );
    expect(await tool.handler({ query: "勤怠システム", since: "昨日" })).toContain("形式が不正");
    expect(await tool.handler({ query: "勤怠システム" })).toContain("締め日は 25 日");
    const over = await tool.handler({ query: "締め日" });
    expect(over).toBe(overLimitMessage(1));
    expect(over).toBe("検索の上限(1 回)に達しました。手元の根拠で回答してください。");
    expect(searched).toBe(1);
    expect(s.stats()).toMatchObject({ calls: 1, hits: 2, overLimit: 1 });
  });

  it("max_tool_calls: 0 はツールを渡さない(返した permalink は空のまま = discord 引用は全て破棄)", () => {
    const s = session(["pub"], 0);
    expect(s.tools).toEqual([]);
    expect(s.returnedPermalinks.size).toBe(0);
    expect(s.stats()).toEqual({ calls: 0, hits: 0, ms: 0, overLimit: 0 });
  });

  it("抜粋の長さ(excerptChars)を設定で変えられ、既定は 200 字", async () => {
    store.upsertMessage(msg("9", "pub", `勤怠システム${"あ".repeat(400)}`));
    const run = async (excerptChars?: number) => {
      const s = createDiscordSearchSession({
        store,
        scope: { guildId: "g1", channelIds: new Set(["pub"]) },
        maxResults: 20,
        ...(excerptChars !== undefined ? { excerptChars } : {}),
      });
      const out = await s.tools[0]?.handler({ query: "あああ" });
      const rows = JSON.parse(String(out).slice(String(out).indexOf("["))) as { excerpt: string }[];
      return [...(rows[0]?.excerpt ?? "").replace(/…/g, "")].length;
    };
    expect(await run()).toBe(200);
    expect(await run(80)).toBe(80);
  });

  it("/ask 統合: ツールを渡し、返した permalink の引用だけ残す(返していない・見えない本文の引用は破棄)", async () => {
    const s = session(["pub"]);
    let seenTools: QaSearchInput["inProcessTools"];
    const deps: AskDeps = {
      getRepos: () => [],
      syncer: {
        sync: async () => [],
        syncEach: async () => [],
        resolveHead: async () => null,
        inspect: async () => null,
        restoreHead: async () => null,
        fetchTimeOnDisk: async () => null,
      },
      promptStore: {
        read: async () => "---\nrole: standard\n---\n本文",
      } satisfies PromptStore,
      store: createMemoryStore(),
      clonesDir: "/clones",
      newId: () => "q1",
      now: () => "2026-10-01T10:00:00+09:00",
      discordSearch: s,
      // モデルの代わり: ツールを 1 回呼び、返ったものと、見えない dev の permalink(推測)を引用する。
      search: async (input) => {
        seenTools = input.inProcessTools;
        await input.inProcessTools?.[0]?.handler({ query: "締め日" });
        return {
          value: {
            answer: "勤怠システムの締め日は 25 日に変更された。",
            citations: [
              { kind: "discord", url: "https://discord.com/channels/100/200/1" },
              { kind: "discord", url: "https://discord.com/channels/100/300/3" },
            ],
            notFound: false,
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const res = await handleAskRequest(
      {
        question: "勤怠の締め日は?",
        discordUserId: "u1",
        discordChannelId: "c",
        threadId: null,
        correlationId: "x",
      },
      deps,
    );
    expect(seenTools?.map((t) => t.name)).toEqual(["discord_search"]);
    expect(res.status).toBe("answered");
    expect(res.answerText).toContain("https://discord.com/channels/100/200/1");
    expect(res.answerText).not.toContain("/300/3");
  });
});
