/**
 * 抽出品質の人手レビュー(design.md §10.3 / §6.3 受け入れ条件)の純粋コア。
 * extractor のリリース前ゲート: 過去議事録 10 件の抽出結果を人手レビューし
 * precision(抽出されたもののうち妥当な割合)>= 0.80(recall は初期は問わない)。
 *
 * フロー: CLI generate が抽出結果をレビュー表 YAML に変換 → 人間が各項目の verdict に
 * ok / ng を記入 → CLI score が precision を算出する。ここは I/O を持たない純関数のみ
 * (score.ts / baseline.ts と同じ流儀)。レビュー表は実議事録の内容を含むためコミット禁止
 * (evals/.review/ は gitignore)。
 */
import type { ExtractionResult } from "@stratum/extractor/candidate";
import yaml from "js-yaml";
import { z } from "zod";

/** 人手レビュー1項目。verdict は生成時 null、人間が ok(妥当)/ ng(不当)を記入する。 */
const reviewItemSchema = z
  .object({
    kind: z.enum(["decision", "learning", "open_question"]),
    title: z.string().min(1),
    /** 抽出本文(decision=決定内容、learning/open_question=body)。判定の根拠。 */
    summary: z.string(),
    /** learning のみ。 */
    domain: z.string().optional(),
    confidence: z.string().optional(),
    /** 議事録内の根拠行(L12-L18 形式)。人間が原文と突合するための手掛かり。 */
    lines: z.string().optional(),
    verdict: z.enum(["ok", "ng"]).nullable(),
    note: z.string().optional(),
  })
  .strict();
export type ReviewItem = z.infer<typeof reviewItemSchema>;

const reviewSheetSchema = z
  .object({
    /** minutes リポジトリ相対パス(どの議事録の抽出か)。 */
    file: z.string().min(1),
    generatedAt: z.string().optional(),
    items: z.array(reviewItemSchema),
  })
  .strict();
export type ReviewSheet = z.infer<typeof reviewSheetSchema>;

/** 抽出結果をレビュー表(verdict 未記入)へ変換する。 */
export function buildReviewSheet(
  file: string,
  extraction: ExtractionResult,
  generatedAt?: string,
): ReviewSheet {
  const items: ReviewItem[] = [
    ...extraction.decisions.map(
      (d): ReviewItem => ({
        kind: "decision",
        title: d.title,
        summary: d.decision,
        confidence: d.confidence,
        ...(d.lines ? { lines: d.lines } : {}),
        verdict: null,
      }),
    ),
    ...extraction.learnings.map(
      (l): ReviewItem => ({
        kind: "learning",
        title: l.title,
        summary: l.body,
        domain: l.domain,
        confidence: l.confidence,
        ...(l.lines ? { lines: l.lines } : {}),
        verdict: null,
      }),
    ),
    ...extraction.openQuestions.map(
      (q): ReviewItem => ({
        kind: "open_question",
        title: q.title,
        summary: q.body,
        ...(q.lines ? { lines: q.lines } : {}),
        verdict: null,
      }),
    ),
  ];
  return { file, ...(generatedAt ? { generatedAt } : {}), items };
}

/** レビュー表を YAML 文字列にする(先頭に記入方法のコメントを付ける)。 */
export function serializeReviewSheet(sheet: ReviewSheet): string {
  const header = [
    "# 抽出品質レビュー表(§6.3)。各項目の verdict に ok(妥当)/ ng(不当)を記入してください。",
    "# 判定基準: 議事録に書かれている内容を正しく抽出しているか(捏造・歪曲・機微情報が無いか)。",
    "# note は任意(ng の理由メモ等)。このファイルは実議事録の内容を含むためコミット禁止。",
  ].join("\n");
  return `${header}\n${yaml.dump(sheet, { lineWidth: 100, noRefs: true })}`;
}

/** 人間がマークしたレビュー表をパースする(不正な verdict は zod が拒否)。 */
export function parseReviewSheet(raw: string): ReviewSheet {
  return reviewSheetSchema.parse(yaml.load(raw));
}

interface KindScore {
  total: number;
  ok: number;
  ng: number;
  unmarked: number;
  /** ok/(ok+ng)。判定済みが 0 件なら null(判定不能)。 */
  precision: number | null;
}

export interface ReviewScore extends KindScore {
  perKind: Record<"decision" | "learning" | "open_question", KindScore>;
  /** §6.3 合格ライン: 全項目判定済み(unmarked=0)かつ precision >= 0.80。 */
  pass: boolean;
}

const PRECISION_FLOOR = 0.8;

function emptyKind(): KindScore {
  return { total: 0, ok: 0, ng: 0, unmarked: 0, precision: null };
}

function finalize(s: KindScore): void {
  const judged = s.ok + s.ng;
  s.precision = judged > 0 ? s.ok / judged : null;
}

/** マーク済みシート群から precision を集計する(§6.3: 分母=抽出全体、分子=妥当)。 */
export function scoreReview(sheets: readonly ReviewSheet[]): ReviewScore {
  const perKind = {
    decision: emptyKind(),
    learning: emptyKind(),
    open_question: emptyKind(),
  };
  const all = emptyKind();
  for (const sheet of sheets) {
    for (const item of sheet.items) {
      const buckets = [all, perKind[item.kind]];
      for (const b of buckets) {
        b.total += 1;
        if (item.verdict === "ok") b.ok += 1;
        else if (item.verdict === "ng") b.ng += 1;
        else b.unmarked += 1;
      }
    }
  }
  finalize(all);
  for (const k of Object.values(perKind)) finalize(k);
  const pass = all.unmarked === 0 && all.precision !== null && all.precision >= PRECISION_FLOOR;
  return { ...all, perKind, pass };
}

/**
 * レビュー対象の議事録を選ぶ: exclude の basename を除外し、パス降順(=日付エンコードされた
 * パスで最新順)に limit 件。extractor の diff 既定(transcript.md 除外)と揃える。
 */
export function selectLatestMinutes(
  relPaths: readonly string[],
  limit: number,
  exclude: readonly string[] = ["transcript.md"],
): string[] {
  const excluded = new Set(exclude);
  return [...relPaths]
    .filter((p) => {
      const base = p.split("/").at(-1) ?? p;
      return p.endsWith(".md") && !excluded.has(base);
    })
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, limit);
}
