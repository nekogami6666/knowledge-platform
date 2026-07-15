/**
 * expertise.yaml による担当者の優先順位付け(design.md §4.4 L302「gap-tracker が expertise.yaml から
 * 自動選定」/ §6.5 / ADR-0017)。question.ts の seam コメントが予告していた Phase 4 の配線。
 *
 * v1 のマッチング: 質問文に topic の label または id が**そのまま含まれる**トピックだけを手掛かりにする
 * (素朴な部分一致。誤爆を避けるためトークン分解はしない)。手掛かりが無ければ空を返し、
 * 呼び出し側は従来のラウンドロビンに委ねる(公平性の既定を崩さない)。
 */
import type { ExpertiseMap } from "@stratum/kb-core";

/**
 * 質問文にマッチする topic の people(evidence_count 降順 = expertise.yaml の並び)を返す。
 * マッチ無しは [](ラウンドロビンへフォールバック)。複数 topic がマッチしたら
 * 「label 一致 > id 一致」→ topic 昇順で最初の 1 つを採る(決定的)。
 */
export function rankByExpertise(question: string, map: ExpertiseMap): string[] {
  const q = question.toLowerCase();
  let best: { score: number; topic: string; people: string[] } | null = null;
  for (const t of map.topics) {
    let score = 0;
    if (t.label.length > 0 && q.includes(t.label.toLowerCase())) score += 2;
    if (q.includes(t.topic.toLowerCase())) score += 1;
    if (score === 0) continue;
    if (
      best === null ||
      score > best.score ||
      (score === best.score && t.topic.localeCompare(best.topic) < 0)
    ) {
      best = { score, topic: t.topic, people: t.people.map((p) => p.name) };
    }
  }
  return best?.people ?? [];
}
