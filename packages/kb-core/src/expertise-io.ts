/**
 * `expertise/expertise.yaml` の読み書き(design.md §4.5: 自動生成・手編集禁止 / ADR-0017 D5)。
 * 純 YAML + zod(members-io と同系統。frontmatter の entry-io とは別)。
 * 書き手は expertise-mapper(機械)のみ。読み手は mapper(増分更新の入力)と gap-tracker
 * (selectAssignee の expertise 優先)。
 */
import { JSON_SCHEMA, dump as yamlDump, load as yamlLoad } from "js-yaml";
import { KbParseError, zodErrorToIssues } from "./errors.js";
import { type ExpertiseMap, expertiseMapSchema } from "./schemas/expertise-map.js";

/** expertise.yaml の全文を parse する。失敗は KbParseError。 */
export function parseExpertiseMap(raw: string, file?: string): ExpertiseMap {
  let data: unknown;
  try {
    data = yamlLoad(raw, { schema: JSON_SCHEMA });
  } catch (cause) {
    throw new KbParseError("INVALID_YAML", "expertise.yaml の YAML 構文が不正です", {
      file,
      cause,
    });
  }
  const result = expertiseMapSchema.safeParse(data);
  if (!result.success) {
    throw new KbParseError("SCHEMA_VIOLATION", "expertise.yaml がスキーマに違反しています", {
      file,
      issues: zodErrorToIssues(result.error),
    });
  }
  return result.data;
}

/**
 * 決定的シリアライズ。同じ内容なら常に同じ文字列になるよう正規化してから dump する
 * (ADR-0017 D5 の「同一内容なら commit しない」比較と週次 diff の安定のため):
 * - topics は topic 昇順
 * - topic 内の people は evidence_count 降順 → name 昇順
 * - キー順はスキーマ定義順に組み直し、dump 作法は serializeEntry と同一
 * 整形前にスキーマで再検証する(§6.1: 不正データをファイル化させない)。
 */
export function serializeExpertiseMap(map: ExpertiseMap): string {
  const normalized = {
    generated_at: map.generated_at,
    topics: [...map.topics]
      .map((t) => ({
        topic: t.topic,
        label: t.label,
        people: [...t.people]
          .sort((a, b) => b.evidence_count - a.evidence_count || a.name.localeCompare(b.name))
          .map((p) => ({
            name: p.name,
            evidence_count: p.evidence_count,
            last_active: p.last_active,
          })),
        bus_factor: t.bus_factor,
        documented_kb_count: t.documented_kb_count,
        risk: t.risk,
      }))
      .sort((a, b) => a.topic.localeCompare(b.topic)),
  };
  const validated = expertiseMapSchema.safeParse(normalized);
  if (!validated.success) {
    throw new KbParseError("SCHEMA_VIOLATION", "expertise map がスキーマに違反しています", {
      issues: zodErrorToIssues(validated.error),
    });
  }
  return yamlDump(validated.data, {
    forceQuotes: true,
    quotingType: '"',
    lineWidth: -1,
    noRefs: true,
  });
}

/**
 * 「内容が同じか」の比較(ADR-0017 D5)。generated_at は生成時刻であって内容ではないため除外する
 * (同一なら yaml を触らない → generated_at は「内容が最後に変わった時刻」の意味になる)。
 */
export function sameExpertiseContent(a: ExpertiseMap, b: ExpertiseMap): boolean {
  const strip = (m: ExpertiseMap): string =>
    serializeExpertiseMap({ ...m, generated_at: "1970-01-01T00:00:00+09:00" });
  return strip(a) === strip(b);
}
