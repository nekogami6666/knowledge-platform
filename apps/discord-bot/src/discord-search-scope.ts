/**
 * /ask の Discord 本文検索の範囲(ADR-0038 D5)= 「質問者に見える」∩「いま bot に見える」∩ ¬permanent_exclude の
 * トップレベルのチャンネル集合。
 *
 * 権限の計算は Discord の標準アルゴリズムを純関数で持つ(discord.js の permissionsFor と同じ順序):
 *   owner → @everyone + ロールの合算 → Administrator → @everyone の上書き → ロールの上書きの合算 → メンバーの上書き
 * - 質問者: ViewChannel ∧ ReadMessageHistory(Administrator・owner は全チャンネル可視 = Discord 上で閲覧できる)。
 * - bot: ViewChannel のみ・checkAdmin なし(ADR-0018 D1 と同じ意味論。Administrator でも「ロールが見える所だけ」)。
 * 公開スレッドは親チャンネルの権限に従うため、判定はトップレベルのチャンネル単位(保存側の parent_channel_id)。
 * private thread は保存していない(ADR-0038 D4)。
 *
 * 限界: ギルドのキャッシュは Gateway イベントで更新されるため、ロールの付け外し直後の数秒は旧権限で判定されうる。
 */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  OverwriteType,
  PermissionFlagsBits,
} from "discord.js";
import { type ChannelsConfig, isChannelAllowed } from "./config.js";

/** 権限計算の入力(discord.js から剥がした純粋データ)。 */
export interface PermGuild {
  id: string;
  ownerId: string;
  /** ロール ID → 権限ビット(@everyone のロール ID はギルド ID)。 */
  rolePermissions: ReadonlyMap<string, bigint>;
}

export interface PermMember {
  id: string;
  /** 付いているロール(@everyone は含めても含めなくてもよい)。 */
  roleIds: readonly string[];
}

export interface PermOverwrite {
  id: string;
  type: "role" | "member";
  allow: bigint;
  deny: bigint;
}

export interface PermChannel {
  id: string;
  /** カテゴリ ID(permanent_exclude の照合用)。 */
  parentId: string | null;
  overwrites: readonly PermOverwrite[];
}

const ALL = (1n << 64n) - 1n;
const VIEW = PermissionFlagsBits.ViewChannel;
const HISTORY = PermissionFlagsBits.ReadMessageHistory;
const ADMIN = PermissionFlagsBits.Administrator;

/**
 * チャンネルでのメンバーの実効権限(Discord の標準アルゴリズム)。checkAdmin=false は owner・Administrator の
 * 全許可を適用しない(bot の可視性判定用・discord.js の permissionsFor(member, false) と同じ)。
 */
export function computeChannelPermissions(
  guild: PermGuild,
  member: PermMember,
  channel: PermChannel,
  checkAdmin: boolean,
): bigint {
  if (checkAdmin && member.id === guild.ownerId) return ALL;
  const roleIds = new Set(member.roleIds);
  roleIds.add(guild.id); // @everyone
  let perms = 0n;
  for (const id of roleIds) perms |= guild.rolePermissions.get(id) ?? 0n;
  if (checkAdmin && (perms & ADMIN) === ADMIN) return ALL;

  const everyone = channel.overwrites.find((o) => o.type === "role" && o.id === guild.id);
  if (everyone !== undefined) {
    perms &= ~everyone.deny;
    perms |= everyone.allow;
  }
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const o of channel.overwrites) {
    if (o.type !== "role" || o.id === guild.id || !roleIds.has(o.id)) continue;
    roleAllow |= o.allow;
    roleDeny |= o.deny;
  }
  perms &= ~roleDeny;
  perms |= roleAllow;
  const own = channel.overwrites.find((o) => o.type === "member" && o.id === member.id);
  if (own !== undefined) {
    perms &= ~own.deny;
    perms |= own.allow;
  }
  return perms;
}

const has = (perms: bigint, bit: bigint): boolean => (perms & bit) === bit;

/** 質問者が本文を読めるチャンネル(ViewChannel ∧ ReadMessageHistory)。 */
export function askerReadableChannelIds(
  guild: PermGuild,
  member: PermMember,
  channels: readonly PermChannel[],
): Set<string> {
  const out = new Set<string>();
  for (const ch of channels) {
    const p = computeChannelPermissions(guild, member, ch, true);
    if (has(p, VIEW) && has(p, HISTORY)) out.add(ch.id);
  }
  return out;
}

/** いま bot が見えて permanent_exclude でないチャンネル(保存側のゲートと同じ意味論)。 */
export function botIndexableChannelIds(
  guild: PermGuild,
  me: PermMember,
  channels: readonly PermChannel[],
  config: ChannelsConfig,
): Set<string> {
  const out = new Set<string>();
  for (const ch of channels) {
    const botCanView = has(computeChannelPermissions(guild, me, ch, false), VIEW);
    if (isChannelAllowed(config, { channelId: ch.id, parentId: ch.parentId, botCanView })) {
      out.add(ch.id);
    }
  }
  return out;
}

/** /ask 1 件の検索範囲。 */
export interface DiscordSearchScope {
  guildId: string;
  /** 検索してよいトップレベルのチャンネル(質問者 ∩ bot ∩ ¬permanent_exclude)。 */
  channelIds: ReadonlySet<string>;
}

/** 純関数版: 質問者 ∩ bot。 */
export function computeSearchScope(
  guild: PermGuild,
  asker: PermMember,
  me: PermMember,
  channels: readonly PermChannel[],
  config: ChannelsConfig,
): DiscordSearchScope {
  const askerSet = askerReadableChannelIds(guild, asker, channels);
  const botSet = botIndexableChannelIds(guild, me, channels, config);
  return { guildId: guild.id, channelIds: new Set([...askerSet].filter((id) => botSet.has(id))) };
}

/**
 * interaction から検索範囲を作る(discord.js の変換だけ・グルー)。判定できない(DM・未キャッシュのギルド・
 * bot 自身の member 不明)場合は null = ツールを渡さない。
 */
export function searchScopeFromInteraction(
  interaction: ChatInputCommandInteraction,
  config: ChannelsConfig,
): DiscordSearchScope | null {
  if (!interaction.inCachedGuild()) return null;
  const guild = interaction.guild;
  const me = guild.members.me;
  if (me === null) return null;
  const permGuild: PermGuild = {
    id: guild.id,
    ownerId: guild.ownerId,
    rolePermissions: new Map(
      [...guild.roles.cache.values()].map((r) => [r.id, r.permissions.bitfield]),
    ),
  };
  const channels: PermChannel[] = [];
  for (const ch of guild.channels.cache.values()) {
    // 判別子(type)で絞る。型述語(isThread 等)で巨大な union を絞ると tsc の型検査が極端に重くなる。
    if (
      ch.type !== ChannelType.GuildText &&
      ch.type !== ChannelType.GuildAnnouncement &&
      ch.type !== ChannelType.GuildForum &&
      ch.type !== ChannelType.GuildMedia
    ) {
      continue;
    }
    channels.push({
      id: ch.id,
      parentId: ch.parentId,
      overwrites: [...ch.permissionOverwrites.cache.values()].map((o) => ({
        id: o.id,
        type: o.type === OverwriteType.Member ? "member" : "role",
        allow: o.allow.bitfield,
        deny: o.deny.bitfield,
      })),
    });
  }
  const member = interaction.member;
  return computeSearchScope(
    permGuild,
    { id: member.id, roleIds: [...member.roles.cache.keys()] },
    { id: me.id, roleIds: [...me.roles.cache.keys()] },
    channels,
    config,
  );
}
