/**
 * 専門性の指標算出(design.md §4.5 / ADR-0017 D6)。**すべて純関数・決定的**。
 * LLM はトピック割当だけを行い、evidence_count / last_active / bus_factor /
 * documented_kb_count / risk はここでコードで計算する(数値の捏造を構造的に排除)。
 */
import type { ExpertiseMap, ExpertisePerson, ExpertiseTopic, Risk } from "@stratum/kb-core";
import { type EvidencePool, laterDate } from "./evidence.js";

/**
 * bus_factor のカバレッジしきい値(2/3)。
 * §4.5 コメント「evidence 上位者が 1 人しかいない」の正典化: evidence を多い順に足して
 * 全体の 2/3 に達するまでの最小人数。1 人が 2/3 以上を占めれば bus_factor = 1。
 * 整数演算のみ(浮動小数の非決定性を避ける)。
 */
export const BUS_FACTOR_COVERAGE_NUM = 2;
export const BUS_FACTOR_COVERAGE_DEN = 3;

/** documented_kb_count の「僅少」しきい値(§4.5: bus_factor=1 かつこれ未満 → risk high)。 */
export const RISK_DOC_MIN = 5;

/** people は evidence_count 降順に整列済みであること。 */
export function busFactor(sorted: readonly { evidence_count: number }[]): number {
  const total = sorted.reduce((s, p) => s + p.evidence_count, 0);
  let cum = 0;
  for (let k = 0; k < sorted.length; k++) {
    cum += sorted[k]?.evidence_count ?? 0;
    if (cum * BUS_FACTOR_COVERAGE_DEN >= total * BUS_FACTOR_COVERAGE_NUM) return k + 1;
  }
  return Math.max(1, sorted.length); // total=0 は起きない(people min1・count>=1)が防御
}

/** risk 判定(ADR-0017 D6: bf=1 かつ doc<5 → high を正典に、段階を定数化)。 */
export function riskOf(busFactorValue: number, documentedKbCount: number): Risk {
  if (busFactorValue <= 1 && documentedKbCount < RISK_DOC_MIN) return "high";
  if (busFactorValue <= 1 || (busFactorValue === 2 && documentedKbCount < RISK_DOC_MIN)) {
    return "medium";
  }
  return "low";
}

/**
 * 割当(material.id → topic)と evidence から topics を決定的に算出する。
 * - people は material 横断で合算(count 加算・last_active は新しい方)
 * - documented_kb_count = kind "kb-entry" の material 数(repo は数えない)
 * - people は evidence_count 降順 → name 昇順、topics は topic 昇順
 * 割当ゼロの topic は生成されない(people 空はスキーマ上も表現不能・§4.5)。
 */
export function computeTopics(
  pool: EvidencePool,
  assignments: ReadonlyMap<string, string>,
  topicLabels: ReadonlyMap<string, string>,
): ExpertiseTopic[] {
  interface Acc {
    people: Map<string, ExpertisePerson>;
    documented: number;
  }
  const byTopic = new Map<string, Acc>();
  for (const m of pool.materials) {
    const topic = assignments.get(m.material.id);
    if (topic === undefined) continue; // 未割当はレポート側で列挙(cluster.ts の unassigned)
    const acc = byTopic.get(topic) ?? { people: new Map(), documented: 0 };
    if (m.material.kind === "kb-entry") acc.documented += 1;
    for (const p of m.people) {
      const cur = acc.people.get(p.person);
      acc.people.set(p.person, {
        name: p.person,
        evidence_count: (cur?.evidence_count ?? 0) + p.count,
        last_active: cur === undefined ? p.lastActive : laterDate(cur.last_active, p.lastActive),
      });
    }
    byTopic.set(topic, acc);
  }

  const topics: ExpertiseTopic[] = [];
  for (const [topic, acc] of byTopic) {
    const label = topicLabels.get(topic);
    if (label === undefined) {
      throw new Error(`topic "${topic}" の label がありません(クラスタリング検証のバグ)`);
    }
    const people = [...acc.people.values()].sort(
      (a, b) => b.evidence_count - a.evidence_count || a.name.localeCompare(b.name),
    );
    const bf = busFactor(people);
    topics.push({
      topic,
      label,
      people,
      bus_factor: bf,
      documented_kb_count: acc.documented,
      risk: riskOf(bf, acc.documented),
    });
  }
  return topics.sort((a, b) => a.topic.localeCompare(b.topic));
}

export function buildExpertiseMap(
  topics: readonly ExpertiseTopic[],
  generatedAt: string,
): ExpertiseMap {
  return { generated_at: generatedAt, topics: [...topics] };
}
