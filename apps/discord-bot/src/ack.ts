/**
 * 応答の共通化(ADR-0030 D1/D2)。「操作したのに無反応」を無くすための最小の 2 機能:
 *  - `ackReaction`: 元メッセージへ ✅(受理)/ ⏳(保留)/ ⚠️(見送り・失敗)を付ける。
 *  - `notifyUser`: DM を試し、失敗したら元メッセージへ返信でフォールバックする(D2)。
 *
 * discord.js は import しない。必要な形(`react` / `reply` / `send`)だけを構造的な seam として
 * 宣言し、テストは配列に積む fake を渡す(CLAUDE.md §12.2。既存の capture.ts tryDm /
 * voice.ts の message.react 呼び出しと同じ形なので、実型はそのまま渡せる)。
 */
import type { Logger } from "pino";
import type { BotStore } from "./db.js";

/** ack の種別(ADR-0030 D1)。 */
export type AckKind = "accepted" | "pending" | "failed";

/** 種別 → リアクション絵文字。✅ 受理 / ⏳ 保留(自動再試行される)/ ⚠️ 見送り・失敗。 */
export const ACK_EMOJI: Record<AckKind, string> = {
  accepted: "✅",
  pending: "⏳",
  failed: "⚠️",
};

/** ack 対象のメッセージ(discord.js Message から必要な口だけを剥がした seam)。 */
export interface AckMessage {
  react(emoji: string): Promise<unknown>;
  reply(content: string): Promise<unknown>;
}

/** DM の宛先(discord.js User から必要な口だけを剥がした seam)。 */
export interface DmTarget {
  send(content: string): Promise<unknown>;
}

/**
 * 元メッセージへ ack リアクションを付ける(ADR-0030 D1)。
 * **ack の失敗で本処理を落とさない** — 権限不足で react できない環境があるため warn のみ。
 */
export async function ackReaction(message: AckMessage, kind: AckKind, log: Logger): Promise<void> {
  try {
    await message.react(ACK_EMOJI[kind]);
  } catch (err) {
    log.warn({ err, kind }, "ack リアクションを付けられませんでした(権限不足の可能性)");
  }
}

/** DM 前提の案内(DM 👍 マージ導線など)を公開の場へ落とすときに添える断り書き。 */
export const DM_BLOCKED_NOTICE =
  "(DM を送れませんでした。DM の受信設定をご確認ください。マージは PR ページからも行えます)";

/**
 * 本人に通知する(ADR-0030 D2)。DM を試し、失敗したら元メッセージへの返信でフォールバックする。
 * どちらも失敗したら warn のみ(そこから先は打つ手が無い)。届いたら true。
 * @param opts.fallbackPrefix 返信でしか届けられなかったときに先頭へ付ける断り書き
 *   (DM 前提の文面をそのまま公開の場に出すと案内が食い違うため)。
 */
export async function notifyUser(
  target: { user: DmTarget; message?: AckMessage },
  content: string,
  log: Logger,
  opts?: { fallbackPrefix?: string },
): Promise<boolean> {
  // 送信直前に秘密値を伏字化する(§9.1。呼び出し側が例外文言を混ぜても漏らさない最後の砦)。
  const safe = scrubSecrets(content);
  try {
    await target.user.send(safe);
    return true;
  } catch (err) {
    log.warn({ err }, "DM 送信に失敗(受信拒否設定の可能性)。元メッセージへの返信を試みます");
  }
  if (target.message === undefined) return false;
  const prefix = opts?.fallbackPrefix;
  try {
    await target.message.reply(prefix === undefined ? safe : `${scrubSecrets(prefix)}\n${safe}`);
    return true;
  } catch (err) {
    log.warn({ err }, "元メッセージへの返信にも失敗しました(通知経路なし)");
  }
  return false;
}

// --- 定型文と抑制(ADR-0030 D3/D4)-------------------------------------------

/** 設定・認証が欠けている入口の案内(D4)。何が足りないかは運用ログ側に出す(§9.1)。 */
export const FEATURE_OFF_MESSAGE =
  "この機能は現在利用できません(設定が未完了です)。管理者に連絡してください。";

/** 一時的失敗(pending が残り、次の kick で自動再試行される経路)の案内(D3)。 */
export const TRANSIENT_RETRY_MESSAGE =
  "一時的な問題で処理できませんでした。あとで自動的に再試行します。";

/** 恒久失敗の理由要約に載せる最大長(Discord に長大なスタックを流さない)。 */
const REASON_MAX = 200;

/** 例外 → 1 行の理由要約(先頭 200 字程度)。秘密を含む例外を投げないのは throw 側の責務。 */
/**
 * Discord へ送る前に秘密値を伏字化する(§9.1)。ロガーは値スクラブを持つが Discord 送信は
 * 経路が別なので、例外メッセージに混入したトークンがそのまま投稿されうる。
 * `setNotifySecrets` に env の秘密値を渡しておくと、通知本文からも同じ値を伏せる。
 */
let notifySecrets: readonly string[] = [];

/** 起動時に一度だけ呼ぶ(index.ts。ロガーへ渡すのと同じ配列)。 */
export function setNotifySecrets(values: readonly string[]): void {
  notifySecrets = values.filter((v) => typeof v === "string" && v.length > 0);
}

/** 通知本文から秘密値を伏字化する(純関数のテストのため export)。 */
export function scrubSecrets(text: string, secrets: readonly string[] = notifySecrets): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

export function failureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = scrubSecrets(raw.replace(/\s+/g, " ").trim());
  if (oneLine.length === 0) return "原因不明";
  return oneLine.length > REASON_MAX ? `${oneLine.slice(0, REASON_MAX)}…` : oneLine;
}

/** 恒久失敗の案内(D3)。「何が起きたか」を短く返して無言をやめる。 */
export function permanentFailureMessage(err: unknown): string {
  return `処理できませんでした: ${failureReason(err)}`;
}

/**
 * 同じ案内の連投を抑える(D3/D4)。JST 日バケットで (subject, kind) あたり 1 回だけ true。
 * capture の日次上限と同じ `hitRateLimit` を流用する(新しいテーブルを増やさない)。
 * subject 例: "user:123"(機能 OFF は人単位)/ "action:abc"(再試行は処理単位)。
 */
export function noticeAllowedOnce(
  store: BotStore,
  subject: string,
  kind: string,
  dayKey: string,
): boolean {
  return store.hitRateLimit(subject, kind, dayKey, 1).allowed;
}
