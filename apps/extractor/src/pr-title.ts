/**
 * 日次 PR のタイトル/ブランチと冪等性判定(design.md §7.1)。
 * タイトルに処理範囲の head SHA を埋め込み、再実行時に既存 open PR を検出して二重作成を防ぐ。
 * カーソルは merge 時にしか main へ反映されないため、merge 前の再実行は同じ範囲=同じ head SHA=同タイトル
 * となり、既存 PR にマッチして skip される(create↔merge ギャップの吸収)。
 */
import type { PrSummary } from "@stratum/gh-client";

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function buildPrTitle(sinceSha: string | null, headSha: string): string {
  const since = sinceSha === null ? "init" : shortSha(sinceSha);
  return `extract: minutes ${since}..${shortSha(headSha)} ナレッジ抽出`;
}

/** タイトルから head の短縮 SHA を取り出す(無ければ null)。 */
export function extractHeadSha(title: string): string | null {
  const m = /extract: minutes \S+\.\.([0-9a-f]{7,40})\b/.exec(title);
  return m?.[1] ?? null;
}

/** 同じ head SHA を対象とする既存 PR を返す(冪等性判定)。 */
export function findExistingPr(prs: readonly PrSummary[], headSha: string): PrSummary | undefined {
  const target = shortSha(headSha);
  return prs.find((p) => extractHeadSha(p.title) === target);
}
