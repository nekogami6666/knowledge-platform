/**
 * ISO 週キー(pr-miner の週次冪等ブランチ名・§6.4 ③-c)。例 "2026-W28"。
 *
 * NOTE(重複回避): この関数は gap-tracker(apps/gap-tracker/src/question.ts の isoWeekKey)からの
 * 意図的なコピー。gap-tracker は package exports を持たず import できないため、9 行の純関数を
 * 複製した(extractor concurrency.ts の SerialQueue NOTE と同方針)。3 つ目の consumer が現れたら
 * packages/shared 等へ統合する。
 */

/** ISO 8601: 週は月曜始まり・その週の木曜が属する年が ISO 年。 */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
