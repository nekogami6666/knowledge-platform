import matter from "gray-matter";
import { JSON_SCHEMA, dump as yamlDump, load as yamlLoad } from "js-yaml";
import type { z } from "zod";
import { KbParseError, zodErrorToIssues } from "./errors.js";
import { decisionRecordSchema } from "./schemas/decision-record.js";
import { knowledgeEntrySchema } from "./schemas/knowledge-entry.js";
import { questionLogSchema } from "./schemas/question-log.js";

export type DocKind = "knowledge" | "decision" | "question";

const SCHEMAS = {
  knowledge: knowledgeEntrySchema,
  decision: decisionRecordSchema,
  question: questionLogSchema,
} as const;

/** serialize 時の frontmatter キー順(design.md §4.2〜4.4 の記載順。diff 安定性 P5)。 */
const KEY_ORDER: Record<DocKind, readonly string[]> = {
  knowledge: [
    "id",
    "title",
    "type",
    "domain",
    "tags",
    "sources",
    "people",
    "confidence",
    "status",
    "supersedes",
    "created",
    "last_verified",
    "review_interval_days",
    "owner",
  ],
  decision: ["id", "title", "date", "status", "deciders", "sources", "tags"],
  question: [
    "id",
    "asked_by",
    "asked_at",
    "channel",
    "question",
    "bot_answer_quality",
    "assignee",
    "status",
    "resulting_kb",
  ],
};

/** YAML タイムスタンプ等の暗黙変換を避け、日付を文字列として読むためのエンジン。 */
const yamlEngine = {
  parse: (input: string): object => (yamlLoad(input, { schema: JSON_SCHEMA }) ?? {}) as object,
  stringify: (): string => {
    throw new Error("serializeEntry を使用してください");
  },
};

type DocOf<K extends DocKind> = z.infer<(typeof SCHEMAS)[K]>;

export interface ParsedEntry<K extends DocKind> {
  frontmatter: DocOf<K>;
  body: string;
}

/**
 * frontmatter + 本文を厳格に parse する。不正な場合は「どのフィールドがなぜ不正か」を
 * 保持する {@link KbParseError} を投げる。
 */
export function parseEntry<K extends DocKind>(
  raw: string,
  docKind: K,
  file?: string,
): ParsedEntry<K> {
  if (!raw.trimStart().startsWith("---")) {
    throw new KbParseError("MISSING_FRONTMATTER", "frontmatter(--- 区切り)がありません", {
      file,
    });
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw, { engines: { yaml: yamlEngine } });
  } catch (cause) {
    throw new KbParseError("INVALID_YAML", "frontmatter の YAML 構文が不正です", {
      file,
      cause,
    });
  }

  if (Object.keys(parsed.data).length === 0) {
    throw new KbParseError("MISSING_FRONTMATTER", "frontmatter が空です", { file });
  }

  const schema = SCHEMAS[docKind] as (typeof SCHEMAS)[K];
  const result = schema.safeParse(parsed.data);
  if (!result.success) {
    throw new KbParseError("SCHEMA_VIOLATION", "frontmatter がスキーマに違反しています", {
      file,
      issues: zodErrorToIssues(result.error),
    });
  }

  return { frontmatter: result.data as DocOf<K>, body: parsed.content };
}

/** parse に失敗しても投げず結果を返す版(validateRepo の一括収集用)。 */
export function safeParseEntry<K extends DocKind>(
  raw: string,
  docKind: K,
  file?: string,
): { ok: true; entry: ParsedEntry<K> } | { ok: false; error: KbParseError } {
  try {
    return { ok: true, entry: parseEntry(raw, docKind, file) };
  } catch (error) {
    if (error instanceof KbParseError) return { ok: false, error };
    throw error;
  }
}

function inferDocKind(frontmatter: Record<string, unknown>): DocKind {
  const id = frontmatter["id"];
  if (typeof id === "string") {
    if (id.startsWith("kb-")) return "knowledge";
    if (id.startsWith("dr-")) return "decision";
    if (id.startsWith("q-")) return "question";
  }
  throw new KbParseError("SCHEMA_VIOLATION", "id から docKind を判定できません", {
    issues: [
      { path: "id", message: "kb- / dr- / q- のいずれかで始まる id が必要です", code: "custom" },
    ],
  });
}

/**
 * frontmatter + 本文を決定的な文字列へ整形する(キー順固定・日付は引用符付き)。
 * `review_interval_days` が null(decision の鮮度確認対象外)のときはキーを出力しない
 * → 再 parse で type 別デフォルト(null)が再適用され round-trip が保たれる。
 */
export function serializeEntry(entry: {
  frontmatter: Record<string, unknown>;
  body: string;
}): string {
  const docKind = inferDocKind(entry.frontmatter);

  // KEY_ORDER 外のキーを無言で破棄しない(将来のスキーマ追加忘れによるデータ消失防止)。
  const known = new Set<string>(KEY_ORDER[docKind]);
  const unknownKeys = Object.keys(entry.frontmatter).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    throw new KbParseError("SCHEMA_VIOLATION", "未知の frontmatter フィールドがあります", {
      issues: unknownKeys.map((k) => ({
        path: k,
        message: `${docKind} スキーマに無いフィールドです`,
        code: "unrecognized_keys",
      })),
    });
  }

  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER[docKind]) {
    const value = entry.frontmatter[key];
    if (value === undefined) continue;
    if (key === "review_interval_days" && value === null) continue;
    ordered[key] = value;
  }

  // 整形前にスキーマで再検証(§6.1: 不正 frontmatter はファイル化させない)。
  // review_interval_days=null は ordered で省略済みのため transform で再補完され通る。
  const validated = SCHEMAS[docKind].safeParse(ordered);
  if (!validated.success) {
    throw new KbParseError("SCHEMA_VIOLATION", "frontmatter がスキーマに違反しています", {
      issues: zodErrorToIssues(validated.error),
    });
  }

  const yamlText = yamlDump(ordered, {
    forceQuotes: true,
    quotingType: '"',
    lineWidth: -1,
    noRefs: true,
  });
  return `---\n${yamlText}---\n${entry.body}`;
}
