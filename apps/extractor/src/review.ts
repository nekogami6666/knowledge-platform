/**
 * レビュー担当の選定(試用運用・㉘/㉞ A3)。
 * - 新規 PR: その日の日替わりローテーション(gap-tracker run.ts の rr と同じ日数基準)。
 * - 滞留 PR のリマインド: **PR 作成日**を anchor に同じ式で再計算 = open の間は担当が固定される
 *   (以前は毎晩 now() で計算していたため、リマインドのたびに宛先が入れ替わっていた)。
 * 実 ID は config(extractor.yaml / Actions vars)から来る — コードに人名・ID を持たない。
 */

/** anchor 日時点のローテーション担当。mentions が空なら undefined(メンション無し)。 */
export function pickReviewer(mentions: readonly string[], anchor: Date): string | undefined {
  if (mentions.length === 0) return undefined;
  return mentions[Math.floor(anchor.getTime() / 86_400_000) % mentions.length];
}

/**
 * PR 作成からの経過日数(切り捨て・負は 0)。createdAt が ISO として読めなければ null
 * (呼び出し側は now 基準の従来挙動へフォールバック)。gap-tracker close.ts の daysSince と同型。
 */
export function daysOpen(createdAt: string, now: Date): number | null {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}
