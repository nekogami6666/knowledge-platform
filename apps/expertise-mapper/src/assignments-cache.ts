/**
 * 割当キャッシュ `_meta/expertise-assignments.json`(ADR-0032)。
 * material(id 不変・ADR-0026)→ topic の割当を KB に永続化し、クラスタリング LLM へは
 * **新規・未割当の material だけ**を送る。所要時間を KB 総量比例 → 週次差分比例に変える。
 *
 * 自動生成・手編集禁止の**派生物**: 壊れていても捨てて全再クラスタすれば完全に再構築できるため、
 * 読み取り失敗は warn + 空キャッシュで自己修復する(expertise.yaml 本体の fail-loud とは非対称。
 * 本体は「壊れたマップを黙って上書きしない」ための停止、こちらは停止する価値が無い)。
 * `_meta/` は validateRepo の走査対象外なので KB validate CI に影響しない(extractor state.json と同じ)。
 */
import { z } from "zod";
import type { TopicMaterial } from "./evidence.js";
import type { Logger } from "./logger.js";

export const ASSIGNMENTS_PATH = "_meta/expertise-assignments.json";

const assignmentsFileSchema = z
  .object({
    version: z.literal(1),
    /** material.id → topic id。unassigned は入れない(毎回再挑戦させる・ADR-0032 D2)。 */
    assignments: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * キャッシュを読む。raw=null(不在)は初回として空。parse/スキーマ失敗は warn + 空
 * (= その週は全再クラスタ・ADR-0032 D3)。
 */
export function readAssignmentsCache(
  raw: string | null,
  logger: Logger,
): Readonly<Record<string, string>> {
  if (raw === null) return {};
  try {
    const parsed = assignmentsFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.assignments;
    logger.warn("expertise-assignments.json がスキーマ不一致のため全再クラスタします", {
      path: ASSIGNMENTS_PATH,
      issue: parsed.error.issues[0]?.message ?? "unknown",
    });
  } catch (e) {
    logger.warn("expertise-assignments.json を JSON として読めないため全再クラスタします", {
      path: ASSIGNMENTS_PATH,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

/** 決定的な直列化(キー昇順)。内容比較(変化時のみ commit)にそのまま使える。 */
export function serializeAssignments(assignments: ReadonlyMap<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const id of [...assignments.keys()].sort()) {
    sorted[id] = assignments.get(id) as string;
  }
  return `${JSON.stringify({ version: 1, assignments: sorted }, null, 2)}\n`;
}

/**
 * materials をキャッシュ命中(cached)と LLM 行き(uncached)に分割する(ADR-0032 D2)。
 * 命中は「割当先 topic が現行マップに実在するもの」に限る — 消滅した topic への割当は
 * 無効化して再クラスタへ回す。KB から消えた material はそもそも materials に居ないので、
 * 戻り値の割当集合から自然に脱落する(eviction)。
 */
export function partitionMaterials(
  materials: readonly TopicMaterial[],
  cache: Readonly<Record<string, string>>,
  validTopics: ReadonlySet<string>,
): { cachedAssignments: Map<string, string>; uncached: TopicMaterial[] } {
  const cachedAssignments = new Map<string, string>();
  const uncached: TopicMaterial[] = [];
  for (const m of materials) {
    const topic = cache[m.id];
    if (topic !== undefined && validTopics.has(topic)) cachedAssignments.set(m.id, topic);
    else uncached.push(m);
  }
  return { cachedAssignments, uncached };
}

/** キャッシュ命中 ∪ LLM 結果(指標算出と次回キャッシュの両方に使う)。キーは今回の materials に限る。 */
export function mergeAssignments(
  cachedAssignments: ReadonlyMap<string, string>,
  llmAssignments: ReadonlyMap<string, string>,
): Map<string, string> {
  const merged = new Map(cachedAssignments);
  for (const [id, topic] of llmAssignments) merged.set(id, topic);
  return merged;
}
