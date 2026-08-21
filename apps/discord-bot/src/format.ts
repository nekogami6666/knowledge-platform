/**
 * 回答 + 出典脚注の整形(design.md §6.2 / P2)。
 * permalink 生成は kb-core の sourceToUrl を再利用する(QaCitation → kb-core Source へ写像)。
 * github_file は commit SHA(resolvedCommit)を ref に持つため、行アンカー付き固定 permalink になる。
 */
import { sourceToUrl } from "@stratum/kb-core";
import type { ResolvedCitation } from "./ask.js";

/** 検証済み引用 → permalink。kb-core の Source 形へ写して sourceToUrl に委ねる。 */
export function citationUrl(c: ResolvedCitation): string {
  switch (c.kind) {
    case "discord":
      return c.url;
    case "github_pr":
      return sourceToUrl({ kind: "pr", repo: c.repo, number: c.number });
    case "github_issue":
      return sourceToUrl({ kind: "issue", repo: c.repo, number: c.number });
    case "github_file":
      return sourceToUrl({
        kind: "meeting",
        repo: c.repo,
        path: c.path,
        ref: c.ref,
        ...(c.lines !== undefined ? { lines: c.lines } : {}),
      });
  }
}

/** stale な KB エントリを引用したときの注記(§6.7 / C8。除外せず注記付きで引用する)。 */
export const STALE_NOTE = "※最終確認から時間が経っています(stale)";

// モデルが本文末尾に自前で書いてしまう出典一覧を落とすためのパターン(§6.2 / P2)。
// 正規の脚注はシステムが検証済み citations[] から付与するため、本文側の重複は番号ズレ・宙ぶらりん
// (検証で破棄された出典が本文に「[3] 不明」等として残る)の原因になる。プロンプト(answer.md v2)で
// 本文への出典記載を禁止済みだが、モデルが規約を破った場合の防御として末尾のみ機械的に掃除する。
// 「出典:/参考:/References」見出し + それに続く [N] 参照、または見出し無しの末尾 [N] 行の連なりだけを
// 対象にし、散文中のインライン [N] には触れない(誤除去を避ける)。
const TRAILING_LABELED_REFS_RE =
  /\n+[ \t]*(?:出典|参考(?:文献)?|references|sources)[ \t]*[:：]?[ \t\r\n]*\[\d+\][\s\S]*$/i;
const TRAILING_BARE_REFS_RE = /\n+(?:[ \t]*\[\d+\][^\n]*(?:\n|$))+$/;

/**
 * モデルが本文に書いた自前の出典ブロック(見出し + [N] 参照行、または見出し無しの末尾 [N] 行)を
 * 除去する。散文中のインライン [N] は保持する(§6.2 / P2)。
 */
export function sanitizeAnswerBody(answer: string): string {
  return answer.replace(TRAILING_LABELED_REFS_RE, "").replace(TRAILING_BARE_REFS_RE, "").trimEnd();
}

/** 回答本文に出典脚注を付す。引用が無ければ本文のみ(呼び出し側で notFound に倒す前提)。 */
export function formatAnswer(answer: string, citations: readonly ResolvedCitation[]): string {
  const body = sanitizeAnswerBody(answer);
  if (citations.length === 0) return body;
  const notes = citations
    .map((c, i) => {
      const stale = c.kind === "github_file" && c.stale === true ? ` ${STALE_NOTE}` : "";
      return `[${i + 1}] ${citationUrl(c)}${stale}`;
    })
    .join("\n");
  return `${body}\n\n出典:\n${notes}`;
}

/** Discord の 1 メッセージ上限(コードポイント数)。 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Discord の 1 メッセージ上限を超えるテキストを送信可能なチャンク列に分割する(§6.2 配送)。
 *
 * 分割点の優先順位: 段落境界 "\n\n" → 行境界 "\n" → 強制カット。段落・行分割では境界の改行を
 * チャンクに残さず捨てる(メッセージ境界自体が視覚的な区切りになり、残すと末尾空白で予算を食うだけ)。
 * formatAnswer の "\n\n出典:\n" 境界は段落規則が自然に拾い、"[n] url" 行は行規則で行単位に保たれる
 * ため、出典ブロックの特別扱いは不要。
 *
 * 長さは .length(UTF-16 コード単位)で数える。Discord の上限はコードポイント数で、単位数 ≥
 * ポイント数のため常に保守側に倒れる。強制カットではサロゲートペアの分断だけ回避する(ZWJ 絵文字
 * 等の書記素クラスタ跨ぎは最終手段として許容)。
 *
 * 不変条件: 各チャンクは非空かつ length <= limit。空文字列は []。
 */
export function splitForDiscord(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // p >= 1 で空チャンクを弾く(先頭が区切りの場合は次の優先度へ落とす)。
    const para = rest.lastIndexOf("\n\n", limit);
    if (para >= 1) {
      chunks.push(rest.slice(0, para));
      rest = rest.slice(para + 2);
      continue;
    }
    const line = rest.lastIndexOf("\n", limit);
    if (line >= 1) {
      chunks.push(rest.slice(0, line));
      rest = rest.slice(line + 1);
      continue;
    }
    const code = rest.charCodeAt(limit - 1);
    const cut = code >= 0xd800 && code <= 0xdbff && limit >= 2 ? limit - 1 : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}
