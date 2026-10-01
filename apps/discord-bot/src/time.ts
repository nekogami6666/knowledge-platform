/**
 * 時刻ユーティリティ(design.md §7.5: 表示・記録は JST(+09:00)・ISO 8601)。
 */

/** 現在時刻(または指定日時)を JST(+09:00)の ISO 8601 文字列で返す。 */
export function isoJst(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

/** 利用者向けの短い JST 表示(例: "10/1 09:12")。/ask の脚注など(§7.5)。 */
export function formatJstShort(date: Date): string {
  const iso = isoJst(date); // 2026-10-01T09:12:34+09:00
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${iso.slice(11, 16)}`;
}
