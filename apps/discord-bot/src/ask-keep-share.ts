/**
 * /ask 回答の「📌 残す」(本人 DM へ保存)と「📢 共有」(確認のうえ共有チャンネルへ公開)(ADR-0040)。
 * ADR-0034 の「回答は本人だけに見える」の例外を、**本人の明示操作**に限って置く。
 *
 * - 押せるのは質問者本人だけ(照合は discord.ts の handleButton が先に済ませる)。
 * - 保存・公開する本文は bot.db の queries.answer(出典脚注・stale 注記込みの最終回答)。
 * - Discord の発言を引用した回答は公開しない(ADR-0038: 質問者の権限で絞った本文が、見られない人に見えるのを防ぐ)。
 * - 公開は 1 回答 1 回まで。shared_answers に予約 → 投稿 → 投稿 ID の順で記録する。
 * - 投稿先は注入された shareChannelId だけ(他のチャンネルには投稿しない)。
 *
 * ログには質問・回答の本文を出さない(queryId・操作・結果コードのみ)。例外は safeErrorInfo で畳む
 * (discord.js のエラーは interaction token を含む URL を持ちうるため)。
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import type { Logger } from "pino";
import { safeErrorInfo } from "./ask-lifecycle.js";
import type { QueryRecord, SharedAnswerStore } from "./db.js";
import { splitForDiscord } from "./format.js";
import { isoJst } from "./time.js";

/** 📌 / 📢 と確認画面のボタン操作。customId は "fb:<action>:<queryId>"。 */
export type KeepShareAction = "keep" | "share" | "share-confirm" | "share-cancel";

export const KEEP_DONE_MESSAGE = "DM に保存しました。";
export const KEEP_DM_FAILED_MESSAGE =
  "DM を送れませんでした。Discord の「プライバシー設定」で、このサーバーのメンバーからのダイレクトメッセージを許可してから、もう一度 📌 を押してください。";
export const KEEP_DM_PARTIAL_MESSAGE =
  "DM の途中で送信に失敗しました(回答の一部だけが届いています)。DM の受信設定を確認して、もう一度 📌 を押してください。";
export const RECORD_NOT_FOUND_MESSAGE = "この回答の記録が見つからないため、保存・共有できません。";
export const SHARE_UNAVAILABLE_MESSAGE = "共有は現在利用できません(共有先が設定されていません)。";
export const SHARE_DISCORD_CITED_MESSAGE =
  "この回答は Discord の発言を引用しているため共有できません。引用元のメッセージは見られる人が限られている場合があるためです(ADR-0038)。📌 で DM に保存できます。";
export const SHARE_CANCELLED_MESSAGE = "共有をやめました。";
export const SHARE_FAILED_MESSAGE = "公開に失敗しました。時間をおいてもう一度お試しください。";

export function shareConfirmMessage(channelId: string): string {
  return `この回答を <#${channelId}> に公開します。質問と回答がメンバー全員に見えます。`;
}

export function alreadySharedMessage(link: string | null): string {
  return link === null
    ? "この回答はすでに共有されています。"
    : `この回答はすでに共有されています: ${link}`;
}

export function shareDoneMessage(link: string, partial: boolean): string {
  return partial
    ? `公開しました(回答の続きは投稿できませんでした): ${link}`
    : `公開しました: ${link}`;
}

/**
 * 出典に Discord の発言を含むか(ADR-0038 / ADR-0040 D3)。queries.sources_json(ResolvedCitation[])を読む。
 * 読めない・形が違う・null は true(= 共有させない側に倒す)。
 */
export function citesDiscord(sourcesJson: string | null): boolean {
  if (sourcesJson === null) return true;
  try {
    const parsed: unknown = JSON.parse(sourcesJson);
    if (!Array.isArray(parsed)) return true;
    return parsed.some(
      (c) => typeof c !== "object" || c === null || (c as { kind?: unknown }).kind === "discord",
    );
  } catch {
    return true;
  }
}

/** 保存・共有できる回答の記録か(回答あり・本文あり)。 */
function isAnsweredRecord(q: QueryRecord | undefined): q is QueryRecord & { answer: string } {
  return q !== undefined && q.answerStatus === "answered" && q.answer !== null;
}

/** 共有の設定(どちらかが無ければ 📢 を出さない)。 */
export interface ShareConfig {
  shareChannelId?: string | undefined;
  sharedAnswers?: SharedAnswerStore | undefined;
}

/** 回答メッセージに 📢 を出すか(共有先の設定あり ∧ 回答あり ∧ Discord 引用なし)。 */
export function canOfferShare(cfg: ShareConfig, q: QueryRecord | undefined): boolean {
  return (
    cfg.shareChannelId !== undefined &&
    cfg.sharedAnswers !== undefined &&
    isAnsweredRecord(q) &&
    !citesDiscord(q.sourcesJson)
  );
}

/** "2026-10-07T09:12:34+09:00" → "2026-10-07 09:12 JST"(queries.created_at は JST・§7.5)。 */
export function formatRecordedAt(createdAt: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(createdAt);
  return m === null ? createdAt : `${m[1]} ${m[2]} JST`;
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/** 📌 の DM 本文(分割済み)。質問は本人自身のものなので載せる。 */
export function buildKeepDm(
  q: Pick<QueryRecord, "question" | "createdAt">,
  answer: string,
): string[] {
  return splitForDiscord(
    `📌 /ask の回答(${formatRecordedAt(q.createdAt)})\n\n**質問**\n${quoted(q.question)}\n\n**回答**\n${answer}`,
  );
}

/** 📢 の公開投稿の本文(分割済み)。メンションは質問者だけ(allowedMentions で別途制限する)。 */
export function buildSharePost(
  q: Pick<QueryRecord, "question" | "discordUserId">,
  answer: string,
): string[] {
  return splitForDiscord(
    `📢 <@${q.discordUserId}> さんの /ask の共有\n\n**質問**\n${quoted(q.question)}\n\n**回答**\n${answer}`,
  );
}

/** 確認画面の「公開する / やめる」。 */
export function shareConfirmButtons(queryId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`fb:share-confirm:${queryId}`)
      .setLabel("公開する")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`fb:share-cancel:${queryId}`)
      .setLabel("やめる")
      .setStyle(ButtonStyle.Secondary),
  );
}

function messageLink(guildId: string | null, channelId: string, messageId: string): string | null {
  return guildId === null
    ? null
    : `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export interface KeepShareDeps extends ShareConfig {
  /** queryId で相関済みのロガー。 */
  log: Logger;
}

const LOG_MSG = "/ask 回答の保存・共有";

/**
 * 📌 / 📢 / 公開する / やめる の処理(ADR-0040)。本人照合は呼び出し側で済んでいる前提。
 * query は getQuery の結果(未登載は undefined)。
 */
export async function handleKeepShareButton(
  interaction: ButtonInteraction,
  action: KeepShareAction,
  queryId: string,
  query: QueryRecord | undefined,
  deps: KeepShareDeps,
): Promise<void> {
  switch (action) {
    case "keep":
      return handleKeep(interaction, queryId, query, deps);
    case "share":
      return handleShare(interaction, queryId, query, deps);
    case "share-confirm":
      return handleShareConfirm(interaction, queryId, query, deps);
    case "share-cancel":
      deps.log.info({ queryId, action, result: "cancelled" }, LOG_MSG);
      await interaction.update({ content: SHARE_CANCELLED_MESSAGE, components: [] });
      return;
  }
}

async function handleKeep(
  interaction: ButtonInteraction,
  queryId: string,
  query: QueryRecord | undefined,
  { log }: KeepShareDeps,
): Promise<void> {
  if (!isAnsweredRecord(query)) {
    log.info({ queryId, action: "keep", result: "no_record" }, LOG_MSG);
    await interaction.reply({ content: RECORD_NOT_FOUND_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }
  // DM の分割送信は 3 秒を超えうるので先に ack する(応答は本人だけ)。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const chunks = buildKeepDm(query, query.answer);
  let sent = 0;
  try {
    for (const content of chunks) {
      await interaction.user.send({ content, allowedMentions: { parse: [] } });
      sent += 1;
    }
  } catch (err) {
    log.warn(
      { queryId, action: "keep", result: "dm_failed", sentChunks: sent, err: safeErrorInfo(err) },
      LOG_MSG,
    );
    await interaction.editReply({
      content: sent === 0 ? KEEP_DM_FAILED_MESSAGE : KEEP_DM_PARTIAL_MESSAGE,
    });
    return;
  }
  log.info({ queryId, action: "keep", result: "ok", chunks: sent }, LOG_MSG);
  await interaction.editReply({ content: KEEP_DONE_MESSAGE });
}

/** 共有の前提を満たさない理由の文面(満たせば null)。📢 と「公開する」の両方で使う。 */
function shareRefusal(
  query: QueryRecord | undefined,
  deps: KeepShareDeps,
  guildId: string | null,
): { code: string; message: string } | null {
  if (deps.shareChannelId === undefined || deps.sharedAnswers === undefined) {
    return { code: "share_off", message: SHARE_UNAVAILABLE_MESSAGE };
  }
  if (!isAnsweredRecord(query)) return { code: "no_record", message: RECORD_NOT_FOUND_MESSAGE };
  if (citesDiscord(query.sourcesJson)) {
    return { code: "discord_cited", message: SHARE_DISCORD_CITED_MESSAGE };
  }
  const shared = deps.sharedAnswers.getSharedAnswer(query.id);
  if (shared !== undefined) {
    const link =
      shared.messageId === null ? null : messageLink(guildId, shared.channelId, shared.messageId);
    return { code: "already_shared", message: alreadySharedMessage(link) };
  }
  return null;
}

async function handleShare(
  interaction: ButtonInteraction,
  queryId: string,
  query: QueryRecord | undefined,
  deps: KeepShareDeps,
): Promise<void> {
  const refusal = shareRefusal(query, deps, interaction.guildId);
  if (refusal !== null || deps.shareChannelId === undefined) {
    deps.log.info({ queryId, action: "share", result: refusal?.code ?? "share_off" }, LOG_MSG);
    await interaction.reply({
      content: refusal?.message ?? SHARE_UNAVAILABLE_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  deps.log.info({ queryId, action: "share", result: "confirm_shown" }, LOG_MSG);
  await interaction.reply({
    content: shareConfirmMessage(deps.shareChannelId),
    components: [shareConfirmButtons(queryId)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleShareConfirm(
  interaction: ButtonInteraction,
  queryId: string,
  query: QueryRecord | undefined,
  deps: KeepShareDeps,
): Promise<void> {
  const { log, shareChannelId, sharedAnswers } = deps;
  const refusal = shareRefusal(query, deps, interaction.guildId);
  if (
    refusal !== null ||
    shareChannelId === undefined ||
    sharedAnswers === undefined ||
    !isAnsweredRecord(query)
  ) {
    log.info({ queryId, action: "share-confirm", result: refusal?.code ?? "share_off" }, LOG_MSG);
    // 確認画面(ephemeral)を理由の文面で置き換える。
    await interaction.update({
      content: refusal?.message ?? SHARE_UNAVAILABLE_MESSAGE,
      components: [],
    });
    return;
  }
  // 1 回答 1 回: 投稿より先に主キーで予約する(連打・二重の確認画面でも 1 回しか投稿しない)。
  if (
    !sharedAnswers.claimSharedAnswer({
      queryId,
      sharedAt: isoJst(),
      channelId: shareChannelId,
      sharedBy: interaction.user.id,
    })
  ) {
    log.info({ queryId, action: "share-confirm", result: "already_shared" }, LOG_MSG);
    await interaction.update({ content: alreadySharedMessage(null), components: [] });
    return;
  }
  let firstMessage: { id: string; url: string } | null = null;
  let posted = 0;
  const chunks = buildSharePost(query, query.answer);
  try {
    await interaction.deferUpdate();
    const channel = await interaction.client.channels.fetch(shareChannelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error("share channel is not sendable");
    }
    for (const content of chunks) {
      // メンションは質問者だけ。回答本文の @everyone・ロール・他人のメンションは通知しない。
      const m = await channel.send({
        content,
        allowedMentions: { parse: [], users: [query.discordUserId] },
      });
      if (firstMessage === null) firstMessage = { id: m.id, url: m.url };
      posted += 1;
    }
  } catch (err) {
    if (firstMessage === null) {
      // 何も投稿していない: 予約を外して再試行できるようにする。
      sharedAnswers.releaseSharedAnswer(queryId);
      log.warn(
        { queryId, action: "share-confirm", result: "post_failed", err: safeErrorInfo(err) },
        LOG_MSG,
      );
      await editShareResult(interaction, SHARE_FAILED_MESSAGE, log, queryId);
      return;
    }
    sharedAnswers.completeSharedAnswer(queryId, firstMessage.id);
    log.warn(
      {
        queryId,
        action: "share-confirm",
        result: "partial",
        postedChunks: posted,
        chunks: chunks.length,
        channelId: shareChannelId,
        messageId: firstMessage.id,
        err: safeErrorInfo(err),
      },
      LOG_MSG,
    );
    await editShareResult(interaction, shareDoneMessage(firstMessage.url, true), log, queryId);
    return;
  }
  if (firstMessage === null) {
    // 本文が空(あり得ない)。予約を戻して終える。
    sharedAnswers.releaseSharedAnswer(queryId);
    await editShareResult(interaction, SHARE_FAILED_MESSAGE, log, queryId);
    return;
  }
  sharedAnswers.completeSharedAnswer(queryId, firstMessage.id);
  log.info(
    {
      queryId,
      action: "share-confirm",
      result: "ok",
      chunks: posted,
      channelId: shareChannelId,
      messageId: firstMessage.id,
    },
    LOG_MSG,
  );
  await editShareResult(interaction, shareDoneMessage(firstMessage.url, false), log, queryId);
}

/** 確認画面を結果の文面に書き換える(失敗しても公開と記録は済んでいるのでログのみ)。 */
async function editShareResult(
  interaction: ButtonInteraction,
  content: string,
  log: Logger,
  queryId: string,
): Promise<void> {
  try {
    await interaction.editReply({ content, components: [] });
  } catch (err) {
    log.warn(
      { queryId, action: "share-confirm", result: "result_edit_failed", err: safeErrorInfo(err) },
      LOG_MSG,
    );
  }
}
