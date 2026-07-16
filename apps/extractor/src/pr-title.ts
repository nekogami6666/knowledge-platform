/**
 * 日次 PR のタイトル/ブランチと冪等性判定(design.md §7.1)。
 * タイトルに処理範囲のランキー(minutes head + kb head の短縮 SHA・PR-I1)を埋め込み、再実行時に
 * 既存 open PR を検出して二重作成を防ぐ。カーソルは merge 時にしか main へ反映されないため、
 * merge 前の再実行は同じ範囲=同じランキー=同タイトルとなり、既存 PR にマッチして skip される
 * (create↔merge ギャップの吸収)。
 */
import type { PrSummary } from "@stratum/gh-client";

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * 実行範囲キー。minutes(議事録リポ)と kb(interviews/ の diff 元)どちらの head が動いても
 * 別ランとして識別される。
 */
export function buildRunKey(minutesHead: string, kbHead: string): string {
  return `${shortSha(minutesHead)}+${shortSha(kbHead)}`;
}

export function buildPrTitle(runKey: string): string {
  return `extract: sources ${runKey} ナレッジ抽出`;
}

/** タイトルからランキーを取り出す(無ければ null)。 */
export function extractRunKey(title: string): string | null {
  const m = /extract: sources ([0-9a-f]{7,40}\+[0-9a-f]{7,40})\b/.exec(title);
  return m?.[1] ?? null;
}

/** 同じランキーを対象とする既存 PR を返す(冪等性判定)。 */
export function findExistingPr(prs: readonly PrSummary[], runKey: string): PrSummary | undefined {
  return prs.find((p) => extractRunKey(p.title) === runKey);
}
