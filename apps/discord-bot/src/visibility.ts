/**
 * discord.js オブジェクト → ChannelGateInput の変換(ADR-0018)。
 * 判定主体は bot 自身の実効 ViewChannel:
 * - /ask(interaction)= `interaction.appPermissions`(payload 同梱・キャッシュ非依存。
 *   interaction は bot 不可視チャンネル・DM からも届くため、これが唯一正確な情報源)
 * - message / reaction = `channel.permissionsFor(guild.members.me, checkAdmin: false)`
 *   (checkAdmin: false — Administrator が付いていても「ロールが見えるチャンネルだけ」の意味論を保つ。
 *   ThreadChannel の permissionsFor は親委譲で、親未キャッシュなら null)
 * 判定不能(DM・channel null・me null・親未キャッシュ)は botCanView: null = 拒否側(安全側の既定)。
 */
import { type Channel, type ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import type { ChannelGateInput } from "./config.js";

/** MessageCreate / ReactionAdd 経路(fetch 済み channel から)。 */
export function gateInputFromChannel(channel: Channel | null, channelId: string): ChannelGateInput {
  if (channel === null || channel.isDMBased()) {
    return { channelId, parentId: null, botCanView: null };
  }
  const parentId = "parentId" in channel ? (channel.parentId ?? null) : null;
  const me = channel.guild.members.me;
  if (me === null) return { channelId, parentId, botCanView: null };
  const perms = channel.permissionsFor(me, false);
  return {
    channelId,
    parentId,
    botCanView: perms?.has(PermissionFlagsBits.ViewChannel) ?? null,
  };
}

/** /ask(interaction)経路。 */
export function gateInputFromInteraction(
  interaction: ChatInputCommandInteraction,
): ChannelGateInput {
  const ch = interaction.channel;
  const parentId = ch !== null && !ch.isDMBased() ? (ch.parentId ?? null) : null;
  return {
    channelId: interaction.channelId,
    parentId,
    botCanView: interaction.appPermissions.has(PermissionFlagsBits.ViewChannel),
  };
}
