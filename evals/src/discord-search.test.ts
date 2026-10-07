/**
 * Discord 本文検索(ADR-0038)の fixture 評価。実 Discord・実モデルなしで次の経路を通す:
 *   fixture(権限・メッセージ)→ 同期(保存時のゲート)→ 質問者ごとの検索範囲 → discord_search → 引用検証
 * 各ケースで「期待する発言が返る」「見えない・除外・保存対象外の発言は返らない」「返していない permalink の
 * 引用は破棄される」を確かめる。ADR-0002: fixture は synthetic。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type {
  DiscordIndexSource,
  PermChannel,
  PermGuild,
  PermMember,
  SourceChannel,
  SourceMessage,
} from "@stratum/discord-bot/discord-search";
import { type QaCitation, validateCitations } from "@stratum/discord-bot/qa";
import { describe, expect, it } from "vitest";

/** better-sqlite3 の native が無い環境では skip(discord-bot の sqlite テストと同じ判定)。 */
function sqliteAvailable(): boolean {
  try {
    const req = createRequire(
      createRequire(import.meta.url).resolve("@stratum/discord-bot/discord-search"),
    );
    const Database = req("better-sqlite3") as new (path: string) => { close(): void };
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  now: string;
  guild: { id: string; ownerId: string; rolePermissions: Record<string, string> };
  permanent_exclude: string[];
  bot: PermMember;
  members: Record<string, PermMember>;
  channels: {
    id: string;
    name: string;
    parentId: string | null;
    overwrites: { id: string; type: "role" | "member"; allow: string; deny: string }[];
  }[];
  threads: { id: string; name: string; parentId: string }[];
  messages: {
    key: string;
    channelId: string;
    author: string;
    createdAt: string;
    content: string;
  }[];
  cases: {
    id: string;
    asker: string;
    args: { query: string; since?: string; until?: string; channel?: string };
    expect: string[];
  }[];
}

const fx = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/discord-index/fixture.json", import.meta.url)),
    "utf8",
  ),
) as Fixture;

const DISCORD_EPOCH_MS = 1_420_070_400_000;
const VIEW = 1n << 10n;

describe.skipIf(!sqliteAvailable())("discord_search fixture 評価(ADR-0038)", () => {
  it("保存時のゲート・質問者の範囲・引用検証が fixture の期待どおり", async () => {
    const ds = await import("@stratum/discord-bot/discord-search");
    const now = Date.parse(fx.now);
    const guild: PermGuild = {
      id: fx.guild.id,
      ownerId: fx.guild.ownerId,
      rolePermissions: new Map(
        Object.entries(fx.guild.rolePermissions).map(([k, v]) => [k, BigInt(v)]),
      ),
    };
    const permChannels: PermChannel[] = fx.channels.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      overwrites: c.overwrites.map((o) => ({
        ...o,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      })),
    }));
    const botCanView = (id: string): boolean => {
      const ch = permChannels.find((c) => c.id === id);
      return (
        ch !== undefined && (ds.computeChannelPermissions(guild, fx.bot, ch, false) & VIEW) !== 0n
      );
    };

    // fixture → Discord 側の fake(snowflake は作成時刻と整合させる)。
    const idOf = new Map<string, string>();
    const byChannel = new Map<string, SourceMessage[]>();
    fx.messages.forEach((m, i) => {
      const createdAt = Date.parse(m.createdAt);
      const id = ((BigInt(createdAt - DISCORD_EPOCH_MS) << 22n) + BigInt(i + 1)).toString();
      idOf.set(m.key, id);
      const list = byChannel.get(m.channelId) ?? [];
      list.push({
        id,
        guildId: guild.id,
        channelId: m.channelId,
        authorId: "0",
        authorName: m.author,
        authorIsBot: false,
        content: m.content,
        createdAt,
        editedAt: null,
        url: `https://discord.com/channels/${guild.id}/${m.channelId}/${id}`,
      });
      byChannel.set(m.channelId, list);
    });
    const sourceChannels: SourceChannel[] = [
      ...fx.channels.map((c) => ({
        id: c.id,
        guildId: guild.id,
        name: c.name,
        kind: "text" as const,
        parentChannelId: c.id,
        gate: { channelId: c.id, parentId: c.parentId, botCanView: botCanView(c.id) },
        parentGate: null,
      })),
      ...fx.threads.map((t) => {
        const parent = fx.channels.find((c) => c.id === t.parentId);
        return {
          id: t.id,
          guildId: guild.id,
          name: t.name,
          kind: "thread" as const,
          parentChannelId: t.parentId,
          gate: { channelId: t.id, parentId: t.parentId, botCanView: botCanView(t.parentId) },
          parentGate: {
            channelId: t.parentId,
            parentId: parent?.parentId ?? null,
            botCanView: botCanView(t.parentId),
          },
        };
      }),
    ];
    const source: DiscordIndexSource = {
      listGuilds: () => [{ id: guild.id, available: true }],
      listChannels: async () => sourceChannels,
      fetchMessagesAfter: async (channelId, afterId, cap) =>
        (byChannel.get(channelId) ?? [])
          .filter((m) => BigInt(m.id) > BigInt(afterId))
          .slice(0, cap),
    };

    const store = ds.createDiscordIndexStore(":memory:");
    const channelsConfig = { permanent_exclude: fx.permanent_exclude };
    const sync = ds.createDiscordIndexSync({
      store,
      source,
      channels: channelsConfig,
      config: {
        enabled: true,
        backfill_days: 90,
        retention_days: 180,
        reconcile_interval_hours: 6,
        reconcile_window_days: 7,
        max_results: 20,
        max_fetch_per_channel: 10_000,
      },
      now: () => now,
    });
    await sync.runCycle();
    // permanent_exclude・bot に見えない・初回取り込みより古い発言は保存されない。
    expect(store.counts().messages).toBe(3);

    const keyOfPermalink = new Map(
      [...idOf].map(([key, id]) => {
        const m = fx.messages.find((x) => x.key === key);
        return [`https://discord.com/channels/${guild.id}/${m?.channelId}/${id}`, key];
      }),
    );
    const failures: string[] = [];
    for (const c of fx.cases) {
      const asker = fx.members[c.asker];
      if (asker === undefined) throw new Error(`unknown asker ${c.asker}`);
      const scope = ds.computeSearchScope(guild, asker, fx.bot, permChannels, channelsConfig);
      const session = ds.createDiscordSearchSession({ store, scope, maxResults: 20 });
      for (const t of session.tools) await t.handler(c.args);
      const got = [...session.returnedPermalinks].map((p) => keyOfPermalink.get(p) ?? p).sort();
      if (JSON.stringify(got) !== JSON.stringify([...c.expect].sort())) {
        failures.push(`${c.id}: got ${JSON.stringify(got)} expected ${JSON.stringify(c.expect)}`);
      }
      // 全メッセージを引用させても、残るのは今回返したものだけ。
      const citations: QaCitation[] = [...keyOfPermalink.keys()].map((url) => ({
        kind: "discord",
        url,
      }));
      const kept = validateCitations(
        citations,
        [],
        () => false,
        () => null,
        session.returnedPermalinks,
      )
        .map((r) => (r.kind === "discord" ? keyOfPermalink.get(r.url) : undefined))
        .sort();
      expect(kept, c.id).toEqual([...c.expect].sort());
    }
    expect(failures).toEqual([]);
    store.close();
  });
});
