/**
 * /ask 利用状況・👍👎 フィードバックの集計(design.md §1.4 KPI)。
 *
 * §1.4 の成功指標「Q&A Bot 利用数(週 15 件以上)」「回答有用率 = 👍/(👍+👎)・70% 以上」を
 * 実際に算出する唯一の場所(§10 は golden-qa 品質評価のみで、この KPI の計測担当は未割当だった)。
 * 純関数のみ。入口は2つ: bot 内 `/stats`(ephemeral)と週次 VM timer バッチ(stats-cli.ts)。
 *
 * すべて `queries` テーブル(§4.6)から集計する。created_at は全行 isoJst() の `+09:00` 固定形式
 * (time.ts)なので、同形式の since 文字列との**辞書順比較 = 時系列比較**でウィンドウを絞れる。
 */
import type { QueryRecord } from "./db.js";
import { isoJst } from "./time.js";

/** KPI 目標(§1.4)。未達は表示で ⚠️ を付ける。 */
export const WEEKLY_ASKS_TARGET = 15;
export const USEFUL_RATE_TARGET = 0.7;

const DAY_MS = 86_400_000;

export interface StatsWindow {
  /** 集計開始時刻(isoJst 形式)。この時刻以降の created_at を対象にする。 */
  since: string;
  asks: number;
  answered: number;
  unanswered: number;
  /** error + delivery_failed(未回答とは区別・§4.6)。 */
  errors: number;
  up: number;
  down: number;
  unrated: number;
  /** up/(up+down)。評価が1件も無ければ null。 */
  usefulRate: number | null;
  /** answered/asks。asks が 0 なら null。 */
  answerRate: number | null;
  /** answered の平均応答時間(ms)。計測可能な行が無ければ null。 */
  avgElapsedMs: number | null;
}

export interface StatsSummary {
  windowDays: number;
  window: StatsWindow;
  /** 累計(全期間)。 */
  total: { asks: number; up: number; down: number; usefulRate: number | null };
}

function usefulRate(up: number, down: number): number | null {
  return up + down === 0 ? null : up / (up + down);
}

/** records(全期間分)から直近 windowDays と累計を集計する。純関数。 */
export function aggregateStats(
  records: readonly QueryRecord[],
  now: Date,
  windowDays = 7,
): StatsSummary {
  const since = isoJst(new Date(now.getTime() - windowDays * DAY_MS));
  const win = records.filter((r) => r.createdAt >= since);

  let answered = 0;
  let unanswered = 0;
  let errors = 0;
  let up = 0;
  let down = 0;
  let elapsedSum = 0;
  let elapsedCount = 0;
  for (const r of win) {
    if (r.answerStatus === "answered") answered += 1;
    else if (r.answerStatus === "unanswered") unanswered += 1;
    else errors += 1; // error / delivery_failed
    if (r.feedback === "up") up += 1;
    else if (r.feedback === "down") down += 1;
    if (r.elapsedMs !== null) {
      elapsedSum += r.elapsedMs;
      elapsedCount += 1;
    }
  }

  let tUp = 0;
  let tDown = 0;
  for (const r of records) {
    if (r.feedback === "up") tUp += 1;
    else if (r.feedback === "down") tDown += 1;
  }

  return {
    windowDays,
    window: {
      since,
      asks: win.length,
      answered,
      unanswered,
      errors,
      up,
      down,
      unrated: win.length - up - down,
      usefulRate: usefulRate(up, down),
      answerRate: win.length === 0 ? null : answered / win.length,
      avgElapsedMs: elapsedCount === 0 ? null : Math.round(elapsedSum / elapsedCount),
    },
    total: { asks: records.length, up: tUp, down: tDown, usefulRate: usefulRate(tUp, tDown) },
  };
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Discord markdown のレポート本文。KPI 未達には ⚠️ を付ける(§1.4)。 */
export function formatStatsMessage(s: StatsSummary): string {
  const w = s.window;
  const asksWarn = w.asks < WEEKLY_ASKS_TARGET ? " ⚠️" : "";
  const usefulWarn = w.usefulRate !== null && w.usefulRate < USEFUL_RATE_TARGET ? " ⚠️" : "";
  const avgSec = w.avgElapsedMs === null ? "—" : `${Math.round(w.avgElapsedMs / 1000)}秒`;
  const sinceDay = w.since.slice(0, 10);

  return [
    `📊 **stratum 利用レポート**(直近 ${s.windowDays} 日 / ${sinceDay} 〜)`,
    "",
    "**利用状況**",
    `- /ask: ${w.asks} 件${asksWarn}(目標 週 ${WEEKLY_ASKS_TARGET} 件)`,
    `- 回答 ${w.answered} / 未回答 ${w.unanswered}(回答率 ${pct(w.answerRate)})`,
    `- 平均応答 ${avgSec}${w.errors > 0 ? ` / エラー ${w.errors}` : ""}`,
    "",
    "**回答の評価**",
    `- 👍 ${w.up} / 👎 ${w.down} / 未評価 ${w.unrated}`,
    `- 有用率 ${pct(w.usefulRate)}${usefulWarn}(目標 ${Math.round(USEFUL_RATE_TARGET * 100)}%)`,
    "",
    `**累計**: /ask ${s.total.asks} 件・👍 ${s.total.up} / 👎 ${s.total.down}・有用率 ${pct(s.total.usefulRate)}`,
  ].join("\n");
}

export interface StatsReportDeps {
  store: { listQueries(): QueryRecord[] };
  now: () => Date;
  /** レポート本文の送信(webhook POST 等)。テストで注入する。 */
  post: (content: string) => Promise<void>;
  logger: { info: (obj: object, msg: string) => void };
}

/** 週次レポートのオーケストレータ(stats-cli.ts が実 seam で呼ぶ)。集計 → 本文 → 送信。 */
export async function runStatsReport(deps: StatsReportDeps): Promise<StatsSummary> {
  const summary = aggregateStats(deps.store.listQueries(), deps.now());
  await deps.post(formatStatsMessage(summary));
  deps.logger.info(
    { asks: summary.window.asks, usefulRate: summary.window.usefulRate },
    "stats report posted",
  );
  return summary;
}
