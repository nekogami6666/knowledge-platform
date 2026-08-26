/**
 * メッセージのフィルタと会話ウィンドウ分割(ADR-0033 D2/D4・純関数)。
 * filter で落としたメッセージもカーソルは前進する(再訪しない)。
 */

/** collector の CollectorMessageItem と構造互換の最小形(discord.js 非依存)。 */
export interface WindowMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdAt: Date;
  hasLightbulb: boolean;
  url: string;
}

export interface FilterResult {
  kept: WindowMessage[];
  /** 落とした内訳(ログ用)。 */
  dropped: { bot: number; lightbulb: number; empty: number; knownUrl: number };
}

/**
 * デデュープ①②③(ADR-0033 D4): bot 発言 / 💡 付き(capture 済み・されるはず)/ 空本文 /
 * KB に既出の permalink を除外する。
 */
export function filterMessages(
  messages: readonly WindowMessage[],
  knownUrls: ReadonlySet<string>,
): FilterResult {
  const kept: WindowMessage[] = [];
  const dropped = { bot: 0, lightbulb: 0, empty: 0, knownUrl: 0 };
  for (const m of messages) {
    if (m.authorIsBot) {
      dropped.bot += 1;
    } else if (m.hasLightbulb) {
      dropped.lightbulb += 1;
    } else if (m.content.trim().length === 0) {
      dropped.empty += 1;
    } else if (knownUrls.has(m.url)) {
      dropped.knownUrl += 1;
    } else {
      kept.push(m);
    }
  }
  return { kept, dropped };
}

export interface WindowOptions {
  /** この分数以上の沈黙で区切る。 */
  gapMinutes: number;
  /** 1 ウィンドウの最大メッセージ数。 */
  maxMessages: number;
  /** 1 ウィンドウの最大文字数(プロンプト有界の防御)。既定 8000。 */
  maxChars?: number;
}

/** oldest-first のメッセージ列を会話ウィンドウへ分割する(時間ギャップ / 件数 / 文字数)。 */
export function groupIntoWindows(
  messages: readonly WindowMessage[],
  opts: WindowOptions,
): WindowMessage[][] {
  const maxChars = opts.maxChars ?? 8_000;
  const gapMs = opts.gapMinutes * 60_000;
  const windows: WindowMessage[][] = [];
  let current: WindowMessage[] = [];
  let chars = 0;
  for (const m of messages) {
    const prev = current[current.length - 1];
    const gapExceeded =
      prev !== undefined && m.createdAt.getTime() - prev.createdAt.getTime() > gapMs;
    const full = current.length >= opts.maxMessages || chars + m.content.length > maxChars;
    if (current.length > 0 && (gapExceeded || full)) {
      windows.push(current);
      current = [];
      chars = 0;
    }
    current.push(m);
    chars += m.content.length;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}
