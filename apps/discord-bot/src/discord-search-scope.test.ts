import { PermissionFlagsBits as P } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  askerReadableChannelIds,
  botIndexableChannelIds,
  computeChannelPermissions,
  computeSearchScope,
  type PermChannel,
  type PermGuild,
  type PermMember,
} from "./discord-search-scope.js";

const G = "g1"; // @everyone のロール ID = ギルド ID
const READ = P.ViewChannel | P.ReadMessageHistory;

function guild(roles: Record<string, bigint>, ownerId = "owner"): PermGuild {
  return { id: G, ownerId, rolePermissions: new Map(Object.entries(roles)) };
}
const member = (id: string, ...roleIds: string[]): PermMember => ({ id, roleIds });
const ch = (
  id: string,
  overwrites: PermChannel["overwrites"] = [],
  parentId: string | null = "cat",
) => ({
  id,
  parentId,
  overwrites,
});
const role = (id: string, allow: bigint, deny = 0n) => ({ id, type: "role" as const, allow, deny });
const mem = (id: string, allow: bigint, deny = 0n) => ({
  id,
  type: "member" as const,
  allow,
  deny,
});

describe("computeChannelPermissions / askerReadableChannelIds(ADR-0038 D5)", () => {
  it("公開チャンネル: @everyone の基本権限で読める", () => {
    const g = guild({ [G]: READ });
    expect(askerReadableChannelIds(g, member("u"), [ch("pub")])).toEqual(new Set(["pub"]));
  });

  it("@everyone の上書きで ViewChannel を拒否した private チャンネルは読めない", () => {
    const g = guild({ [G]: READ });
    const priv = ch("priv", [role(G, 0n, P.ViewChannel)]);
    expect(askerReadableChannelIds(g, member("u"), [priv])).toEqual(new Set());
  });

  it("ロールの上書きで許可されたメンバーだけ private チャンネルを読める", () => {
    const g = guild({ [G]: READ, dev: 0n });
    const priv = ch("priv", [role(G, 0n, P.ViewChannel), role("dev", P.ViewChannel)]);
    expect(askerReadableChannelIds(g, member("a", "dev"), [priv])).toEqual(new Set(["priv"]));
    expect(askerReadableChannelIds(g, member("b"), [priv])).toEqual(new Set());
  });

  it("ロールの上書きは合算してから deny → allow の順(同じ階層では allow が勝つ)", () => {
    const g = guild({ [G]: READ, a: 0n, b: 0n });
    const c = ch("c", [role("a", 0n, P.ViewChannel), role("b", P.ViewChannel)]);
    expect(askerReadableChannelIds(g, member("u", "a", "b"), [c])).toEqual(new Set(["c"]));
    expect(askerReadableChannelIds(g, member("u", "a"), [c])).toEqual(new Set());
  });

  it("メンバー個別の上書きはロールより優先(個別 deny で読めなくなる・個別 allow で読める)", () => {
    const g = guild({ [G]: READ, dev: 0n });
    const denied = ch("c1", [mem("u", 0n, P.ViewChannel)]);
    const allowed = ch("c2", [role(G, 0n, P.ViewChannel), mem("u", P.ViewChannel)]);
    expect(askerReadableChannelIds(g, member("u", "dev"), [denied, allowed])).toEqual(
      new Set(["c2"]),
    );
  });

  it("ViewChannel があっても ReadMessageHistory が無ければ本文は読めない扱い", () => {
    const g = guild({ [G]: READ });
    const c = ch("c", [role(G, 0n, P.ReadMessageHistory)]);
    expect(askerReadableChannelIds(g, member("u"), [c])).toEqual(new Set());
  });

  it("ギルドの基本権限で @everyone に閲覧が無くても、ロールの基本権限で読める", () => {
    const g = guild({ [G]: 0n, member: READ });
    expect(askerReadableChannelIds(g, member("u", "member"), [ch("c")])).toEqual(new Set(["c"]));
    expect(askerReadableChannelIds(g, member("guest"), [ch("c")])).toEqual(new Set());
  });

  it("Administrator・owner は上書きに関わらず全チャンネルを読める(Discord 上で閲覧できる)", () => {
    const g = guild({ [G]: READ, admin: P.Administrator });
    const priv = ch("priv", [role(G, 0n, P.ViewChannel | P.ReadMessageHistory)]);
    expect(askerReadableChannelIds(g, member("a", "admin"), [priv])).toEqual(new Set(["priv"]));
    expect(askerReadableChannelIds(g, member("owner"), [priv])).toEqual(new Set(["priv"]));
  });

  it("checkAdmin=false(bot 用)は Administrator の全許可を適用しない", () => {
    const g = guild({ [G]: READ, admin: P.Administrator });
    const priv = ch("priv", [role(G, 0n, P.ViewChannel)]);
    const perms = computeChannelPermissions(g, member("bot", "admin"), priv, false);
    expect(perms & P.ViewChannel).toBe(0n);
  });
});

describe("botIndexableChannelIds / computeSearchScope", () => {
  const g = guild({ [G]: READ, bot: 0n, dev: 0n });
  const pub = ch("pub");
  const devOnly = ch("dev", [role(G, 0n, P.ViewChannel), role("dev", P.ViewChannel)]);
  const botHidden = ch("hidden", [role("bot", 0n, P.ViewChannel)]);
  const hr = ch("hr");
  const underExcludedCat = ch("x", [], "hrcat");
  const all = [pub, devOnly, botHidden, hr, underExcludedCat];
  const config = { permanent_exclude: ["hr", "hrcat"] };

  it("bot: 見える ∧ ¬permanent_exclude(カテゴリの除外も効く)", () => {
    expect(botIndexableChannelIds(g, member("bot", "bot"), all, config)).toEqual(new Set(["pub"]));
  });

  it("範囲 = 質問者に見える ∩ bot に見える: 権限の無い人は dev の本文を検索できない", () => {
    const botWithDev = member("bot", "bot", "dev");
    const dev = computeSearchScope(g, member("a", "dev"), botWithDev, all, config);
    const guest = computeSearchScope(g, member("b"), botWithDev, all, config);
    expect(dev.channelIds).toEqual(new Set(["pub", "dev"]));
    expect(guest.channelIds).toEqual(new Set(["pub"]));
    expect(dev.guildId).toBe(G);
  });
});
