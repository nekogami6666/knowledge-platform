/**
 * 日次 PR のタイトル/ブランチと冪等性判定(design.md §7.1)。
 * タイトルには処理範囲のランキー(minutes head + kb head の短縮 SHA・PR-I1)を残し、どの範囲を
 * 処理した PR かを人が読めるようにする。
 *
 * 冪等性の判定は**ブランチ名の prefix**(`extract/`)で行う(pr-miner の `pr-miner/` と同型)。
 * カーソル(_meta/state.json)は merge 時にしか main へ反映されないため、未マージの PR がある間は
 * 何度実行しても同じ範囲を再抽出することになる。当初はランキー一致で判定していたが、上流
 * (議事録リポ)に新コミットが入るとランキーが変わってガードが外れ、未マージ PR が毎晩積み上がった
 * (2026-07-29: KB に 3 本が同時 open・id-counter が衝突して同時マージ不可)。ブランチ prefix なら
 * 範囲に関係なく「未マージの抽出 PR が 1 本でもあれば見送る」が成立し、PR タイトルを人が編集しても効く。
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

/** 抽出 PR のブランチ prefix(`buildBranch` と冪等ガードで共有)。 */
export const EXTRACT_BRANCH_PREFIX = "extract/";

export function buildBranch(runKey: string): string {
  return `${EXTRACT_BRANCH_PREFIX}${runKey}`;
}

/**
 * 未マージの抽出 PR を返す(冪等性判定)。範囲(ランキー)は問わない — 1 本でも open なら
 * 今回の run は見送る。カーソルが進むのは merge 時なので、先に人がさばくのが正しい順序。
 */
export function findOpenExtractPr(prs: readonly PrSummary[]): PrSummary | undefined {
  return prs.find((p) => p.headRef.startsWith(EXTRACT_BRANCH_PREFIX));
}
