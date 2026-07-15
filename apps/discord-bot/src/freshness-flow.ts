/**
 * 鮮度確認の bot 側 UI(design.md §6.7 / ADR-0019 D2/D3・PR-F4)。
 * freshness-checker(VM timer)が積んだ pending_actions(type: "freshness")を消費して
 * owner へ DM を送り(worker)、その DM への 👍✏️🗑 リアクションで応答を処理する。
 * - 👍 = last_verified を今日へ更新して main 直 commit
 * - ✏️ = 編集用 PR の雛形(本文に現エントリ全文)を作ってリンクを返信
 * - 🗑 = status: stale へ main 直 commit + 矛盾検出キューへ積む
 * main 直 commit は push 前にローカル validateRepo(ADR-0019 D3 / ADR-0004 D2)。
 * 判定(freshnessReactionDecision)と適用(applyFreshnessReaction)は純関数/注入 seam で
 * 単体テストし、discord.js グルーは薄く保つ(CLAUDE.md §12.2・proxyMerge と同じ構成)。
 */
import { join } from "node:path";
import type { GhClient } from "@stratum/gh-client";
import { safeParseEntry, serializeEntry } from "@stratum/kb-core";
import type { MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import type { Logger } from "pino";
import { SerialQueue } from "./concurrency.js";
import type { BotStore, PendingAction } from "./db.js";
import {
  FRESHNESS_ACTION_TYPE,
  type FreshnessPayload,
  parseFreshnessPayload,
} from "./freshness.js";

/** 🗑(もう古い)申告時に積む矛盾検出キューの type(ADR-0019 D2。消費者は将来の矛盾検出バッチ)。 */
export const CONTRADICTION_ACTION_TYPE = "contradiction_check";

// --- DM 本文と ref(リアクション → アクションの逆引きは DM 本文の ref 行で行う。
//     capture の「DM 内 PR URL」と同じ、bot 自身のメッセージを台帳にする流儀)---

export function buildFreshnessDm(payload: FreshnessPayload, actionId: string): string {
  return [
    `🕰️ ナレッジの鮮度確認です: **${payload.title}**`,
    `\`${payload.path}\`(最終確認 ${payload.lastVerified})`,
    "この内容はまだ正しいですか? このメッセージへのリアクションで教えてください:",
    "👍 正しい(last_verified を今日に更新) / ✏️ 直す(編集用 PR を作成) / 🗑 もう古い(stale へ)",
    `(ref: freshness/${actionId})`,
  ].join("\n");
}

export function parseFreshnessRef(content: string): string | null {
  const m = /\(ref: freshness\/([0-9A-Za-z-]+)\)/.exec(content);
  return m === null ? null : (m[1] as string);
}

// --- リアクション判定(純関数)---

export type FreshnessKind = "verify" | "edit" | "trash";

/** 絵文字 → 操作。キーは変異セレクタ(U+FE0F)除去後の名前(✏️/🗑️ は端末により有無が揺れる)。 */
const EMOJI_KIND: Record<string, FreshnessKind> = {
  "👍": "verify",
  "✏": "edit",
  "🗑": "trash",
};

export interface FreshnessReactionInput {
  emojiName: string | null;
  reactorIsBot: boolean;
  /** guildId === null(DM)。 */
  isDm: boolean;
  /** bot 自身が送ったメッセージか。 */
  messageAuthorIsSelf: boolean;
  content: string;
}

export type FreshnessDecision =
  | { act: false; reason: string }
  | { act: true; kind: FreshnessKind; actionId: string };

export function freshnessReactionDecision(input: FreshnessReactionInput): FreshnessDecision {
  const kind = EMOJI_KIND[(input.emojiName ?? "").replace(/\uFE0F/g, "")];
  if (kind === undefined) return { act: false, reason: "not-freshness-emoji" };
  if (input.reactorIsBot) return { act: false, reason: "bot-reactor" };
  // DM は bot と owner の 2 者だけ。bot 自身が送った鮮度確認 DM のみを応答導線とする(proxyMerge と同型)。
  if (!input.isDm) return { act: false, reason: "not-dm" };
  if (!input.messageAuthorIsSelf) return { act: false, reason: "not-self-dm" };
  const actionId = parseFreshnessRef(input.content);
  if (actionId === null) return { act: false, reason: "no-ref" };
  return { act: true, kind, actionId };
}

// --- 適用(👍✏️🗑 の 3 分岐。副作用は全て注入 seam)---

export interface FreshnessApplyDeps {
  store: BotStore;
  gh: GhClient;
  /** "org/knowledge-base"(ops.yaml の kb_repo。§6.3 代理マージと同じ唯一の書き込み先)。 */
  kbRepo: string;
  /** commit / PR のベースブランチ(gh-client の既定と同じ "main")。 */
  baseBranch: string;
  /** KB clone を最新化して絶対パスを返す(ローカル validateRepo 用・ADR-0019 D3)。 */
  syncKbClone(): Promise<string>;
  readFile(absPath: string): Promise<string>;
  writeFile(absPath: string, content: string): Promise<void>;
  validate(kbRoot: string): Promise<{ ok: boolean; problems: readonly unknown[] }>;
  /** JST の今日(YYYY-MM-DD)。 */
  today(): string;
  makeId(): string;
  /** ISO 8601 JST(§7.5)。 */
  nowIso(): string;
  logger: Logger;
}

/** リアクション 1 件を適用し、DM へ返す文言を返す(返信は呼び手のグルーが行う)。 */
export async function applyFreshnessReaction(
  kind: FreshnessKind,
  actionId: string,
  deps: FreshnessApplyDeps,
): Promise<string> {
  const action = deps.store
    .listPendingActions(FRESHNESS_ACTION_TYPE)
    .find((a) => a.id === actionId);
  // 冪等: 二重リアクション・bot 再起動後の再配送でも二重 commit しない。
  if (action === undefined || action.state === "done") {
    return "この鮮度確認は処理済みです(操作は不要です)。";
  }
  const payload = parseFreshnessPayload(action.payloadJson);
  if (payload === null) {
    deps.store.markActionDone(action.id);
    return "この確認は記録が壊れているため処理できません(破棄しました)。";
  }
  if (kind === "edit") return createEditPr(action, payload, deps);
  return commitVerdict(kind, action, payload, deps);
}

/** 👍(last_verified 更新)/ 🗑(stale 降格)の main 直 commit(ADR-0019 D3)。 */
async function commitVerdict(
  kind: "verify" | "trash",
  action: PendingAction,
  payload: FreshnessPayload,
  deps: FreshnessApplyDeps,
): Promise<string> {
  const kbRoot = await deps.syncKbClone();
  let raw: string;
  try {
    raw = await deps.readFile(join(kbRoot, payload.path));
  } catch {
    deps.store.markActionDone(action.id);
    return `対象エントリが見つかりませんでした(\`${payload.path}\`)。移動/削除済みとして記録しました。`;
  }
  const parsed = safeParseEntry(raw, "knowledge", payload.path);
  if (!parsed.ok) {
    // 壊れた frontmatter に機械変更を重ねない。人間の修正後に再リアクションで再試行できるよう pending 温存。
    return `⛔ エントリの frontmatter が壊れているため処理できません(\`${payload.path}\`)。修正後にもう一度リアクションしてください。`;
  }
  const fm = parsed.entry.frontmatter;
  if (fm.status !== "active") {
    deps.store.markActionDone(action.id);
    return `このエントリは既に active ではありません(status: ${fm.status})。操作は不要です。`;
  }
  const today = deps.today();
  const next =
    kind === "verify" ? { ...fm, last_verified: today } : { ...fm, status: "stale" as const };
  const content = serializeEntry({ frontmatter: next, body: parsed.entry.body });
  await deps.writeFile(join(kbRoot, payload.path), content);
  const report = await deps.validate(kbRoot);
  if (!report.ok) {
    // ADR-0004 D2: 壊れた状態を main へ push しない。pending 温存(KB 修正後に再リアクション)。
    return `⛔ commit しません: validateRepo が失敗しました(${report.problems.length} 件)。KB の状態を確認してください。`;
  }
  await deps.gh.commitFiles({
    repo: deps.kbRepo,
    branch: deps.baseBranch,
    message:
      kind === "verify"
        ? `chore(freshness): ${payload.entryId} の last_verified を ${today} に更新(owner 確認 👍)`
        : `chore(freshness): ${payload.entryId} を stale へ降格(owner 申告 🗑)`,
    files: [{ path: payload.path, content }],
  });
  if (kind === "trash") {
    // ADR-0019 D2: 「もう古い」は矛盾の兆候 — 関連エントリの矛盾検出キューへ積む。
    deps.store.queueAction({
      id: deps.makeId(),
      type: CONTRADICTION_ACTION_TYPE,
      queryId: null,
      payloadJson: JSON.stringify({
        entryId: payload.entryId,
        path: payload.path,
        reason: "freshness_trash",
      }),
      state: "pending",
      createdAt: deps.nowIso(),
    });
  }
  deps.store.markActionDone(action.id);
  return kind === "verify"
    ? `✅ \`${payload.path}\` の last_verified を ${today} に更新しました。`
    : `🗑 \`${payload.path}\` を stale にしました(/ask では注記付きで引用されます)。矛盾チェックをキューに積みました。`;
}

/** ✏️: 編集用 PR の雛形(変更は last_verified の更新のみ。内容の編集は owner が PR 上で行う)。 */
async function createEditPr(
  action: PendingAction,
  payload: FreshnessPayload,
  deps: FreshnessApplyDeps,
): Promise<string> {
  const kbRoot = await deps.syncKbClone();
  let raw: string;
  try {
    raw = await deps.readFile(join(kbRoot, payload.path));
  } catch {
    deps.store.markActionDone(action.id);
    return `対象エントリが見つかりませんでした(\`${payload.path}\`)。移動/削除済みとして記録しました。`;
  }
  const parsed = safeParseEntry(raw, "knowledge", payload.path);
  // 壊れていても雛形 PR は作れる(frontmatter の修正自体が編集の目的になりうる)。
  const content = parsed.ok
    ? serializeEntry({
        frontmatter: { ...parsed.entry.frontmatter, last_verified: deps.today() },
        body: parsed.entry.body,
      })
    : raw;
  const pr = await deps.gh.createPullRequest({
    repo: deps.kbRepo,
    head: `freshness/${payload.entryId}-${action.id.slice(0, 8)}`,
    title: `docs(kb): ${payload.entryId} ${payload.title} を更新(鮮度確認 ✏️)`,
    body: [
      "鮮度確認(✏️ 直す)から自動作成された編集用 PR の雛形です(ADR-0019 D2)。",
      `- エントリ: \`${payload.path}\``,
      `- owner: @${payload.ownerGithub}`,
      "- このブランチ上でエントリを編集してからマージしてください(雛形の変更は last_verified の更新のみ)。",
      "",
      "## 現在の全文",
      "",
      "````markdown",
      raw.trimEnd(),
      "````",
    ].join("\n"),
    files: [{ path: payload.path, content }],
    base: deps.baseBranch,
  });
  deps.store.markActionDone(action.id);
  return [
    `✏️ 編集用 PR を作りました: ${pr.url}`,
    "エントリを PR 上で編集し、内容が正しくなったらマージしてください(validate が緑なら、PR リンクを含むこの返信への 👍 で代理マージもできます・§6.3)。",
  ].join("\n");
}

// --- DM 送信 worker(checker が積んだ pending を消費する常駐側・ADR-0019 D2)---

export interface FreshnessDmDeps {
  logger: Logger;
  store: BotStore;
  /** DM 送信(discord.ts の createClientMessenger)。 */
  dm(userId: string, content: string): Promise<void>;
}

/** pending の鮮度確認を DM で送り、送信済みは state:"sent" へ前進する(再起動時の二重送信防止)。 */
export async function drainFreshnessDms(deps: FreshnessDmDeps): Promise<void> {
  const pending = deps.store
    .listPendingActions(FRESHNESS_ACTION_TYPE)
    .filter((a) => a.state === "pending");
  for (const action of pending) {
    const payload = parseFreshnessPayload(action.payloadJson);
    if (payload === null) {
      deps.logger.warn({ actionId: action.id }, "freshness payload が不正のため破棄します");
      deps.store.markActionDone(action.id);
      continue;
    }
    try {
      await deps.dm(payload.ownerDiscord, buildFreshnessDm(payload, action.id));
      deps.store.setActionState(action.id, "sent");
    } catch (err) {
      // DM 拒否設定等。pending 温存 → 次回 kick で再試行。届かないままなら checker の
      // 14 日自動 stale が安全弁になる(ADR-0019「影響・トレードオフ」)。
      deps.logger.warn({ err, actionId: action.id }, "鮮度確認 DM の送信に失敗しました");
    }
  }
}

/** 直列ワーカー。kick() は多重に呼ばれても 1 本ずつ順に drain する(voice-pipeline と同型)。 */
export function createFreshnessDmWorker(deps: FreshnessDmDeps): { kick(): void } {
  const queue = new SerialQueue();
  return {
    kick() {
      void queue
        .enqueue(() => drainFreshnessDms(deps))
        .catch((err) => deps.logger.error({ err }, "freshness DM worker error"));
    },
  };
}

// --- discord.js グルー(統合テストで代替・CLAUDE.md §12.2)---

export async function handleFreshnessReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  deps: { logger: Logger; freshness?: FreshnessApplyDeps },
): Promise<void> {
  if (deps.freshness === undefined) return; // 機能 OFF(gh 認証か ops.kb_repo が無い)
  try {
    // DM はキャッシュ外で partial として届くため、実体を fetch してから判定する(proxyMerge と同じ)。
    const r = reaction.partial ? await reaction.fetch() : reaction;
    const message = r.message.partial ? await r.message.fetch() : r.message;
    const reactor = user.partial ? await user.fetch() : user;
    const decision = freshnessReactionDecision({
      emojiName: r.emoji.name,
      reactorIsBot: reactor.bot,
      isDm: message.guildId === null,
      messageAuthorIsSelf:
        message.author?.id !== undefined && message.author.id === message.client?.user?.id,
      content: message.content,
    });
    if (!decision.act) return; // 対象外のリアクションには反応しない(通常運用で大量に発生する)
    const replyText = await applyFreshnessReaction(
      decision.kind,
      decision.actionId,
      deps.freshness,
    );
    await message.reply(replyText);
  } catch (err) {
    deps.logger.warn({ err }, "freshness リアクションの処理に失敗しました");
    try {
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      await message.reply("処理に失敗しました。時間をおいてもう一度リアクションしてください。");
    } catch {
      // DM 不達まで追わない(ログ済み)。
    }
  }
}
