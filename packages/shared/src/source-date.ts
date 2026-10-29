/**
 * 議事録パスから「源泉日」を機械的にパースする(ADR-0026 D3)。
 * エントリの created / last_verified / decision の date / ID の年は「知識の時点」= 議事録の日付を
 * 使う(抽出実行日ではない)。LLM は使わない(パスは決定的)。パース不能は null(呼び出し側が
 * now() にフォールバック)。
 *
 * extractor(源泉日)と discord-bot の System One カタログ(議事録の日付・ADR-0041 D4)の 2 か所で
 * 使うため @stratum/shared に置く(discord-bot から extractor へは import できない — 依存は逆向き)。
 *
 * 対応形式:
 * - 実 dev-minutes: `meetings/internal/2026/2026-06/2026_06_11_from_18-59_.../minutes.md`(YYYY_MM_DD)
 * - 会議 ID 形式:   `meetings/2026/2026-09/mtg-2026-09-15T10-00-00-abcd/minutes.md`(ISO 8601 拡張形式)
 *                   `meetings/2026/2026-09/mtg-20260915T100000-abcd/minutes.md`(ISO 8601 基本形式)
 * - synthetic 等:   `minutes/2026/06/2026-06-03-hw-weekly.md`(YYYY-MM-DD)
 */

/** YYYY/MM/DD の文字列 3 つから JST 深夜の Date を作る(月日が不正なら null)。 */
function jstMidnight(y: string, mo: string, d: string): Date | null {
  const date = new Date(`${y}-${mo}-${d}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return null;
  // 月日の妥当性(2026-99-99 のような数字列を弾く。Date は自動繰上げするため文字列で照合)
  const jst = new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  return jst === `${y}-${mo}-${d}` ? date : null;
}

/** パスから最初に現れる日付(YYYY_MM_DD または YYYY-MM-DD)を JST 深夜の Date で返す。 */
export function minutesDateFromPath(relPath: string): Date | null {
  const m = /(\d{4})[_-](\d{2})[_-](\d{2})/.exec(relPath);
  if (m !== null) {
    const [, y, mo, d] = m;
    if (y === undefined || mo === undefined || d === undefined) return null;
    return jstMidnight(y, mo, d);
  }
  // ISO 8601 基本形式(YYYYMMDDThh)。T の続かない 8 桁の数字列は日付と見なさない(ID 等の誤認を避ける)。
  const basic = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})T\d{2}/.exec(relPath);
  if (basic === null) return null;
  const [, y, mo, d] = basic;
  if (y === undefined || mo === undefined || d === undefined) return null;
  return jstMidnight(y, mo, d);
}
