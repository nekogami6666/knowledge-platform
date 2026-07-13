/**
 * トピッククラスタリングの LLM 契約(design.md §6.6 ⑤-a / ADR-0017 D6)。
 * LLM(deep)の仕事は「material の topic への割当」と「新 topic の命名」だけ。
 * 人名・数値は入出力に存在しない(指標は metrics.ts がコードで決定的に算出する)。
 *
 * 名前安定(週跨ぎ 9 割・AC)の構造的担保:
 * - 既存 topic の label は出力に欄が無い = rename が構文上不可能(label は現 expertise.yaml から引き継ぐ)
 * - 出力はコードで後検証し、参照整合違反は是正フィードバック付きで 1 回だけ再試行 → それでも駄目なら
 *   fail-loud(部分出力で expertise.yaml を汚さない)
 * - 未割当 material は除外してレポートに列挙する(silent drop しない)
 */
import {
  type AgentSearchOptions,
  type AgentSearchResult,
  type LlmDeps,
  loadPrompt,
  nullUsageRecorder,
  type PromptStore,
  type RetryOptions,
  runAgentSearch,
  type Usage,
  type UsageRecorder,
  withRetry,
} from "@stratum/llm";
import { z } from "zod";
import type { TopicMaterial } from "./evidence.js";

export const topicIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "topic は英小文字・数字とハイフン(kebab-case)");

export const clusteringResultSchema = z
  .object({
    // 両配列とも必須(空でも [] を返させる)。outputSchema は入力型=出力型が必要なため default は使わない。
    assignments: z.array(
      z.object({ material_id: z.string().min(1), topic: topicIdSchema }).strict(),
    ),
    new_topics: z.array(z.object({ topic: topicIdSchema, label: z.string().min(1) }).strict()),
  })
  .strict();
export type ClusteringResult = z.infer<typeof clusteringResultSchema>;

/** 既存トピックの参照(id + label)。 */
export interface TopicRef {
  topic: string;
  label: string;
}

/** material 一覧 + 既存トピックから決定的な user prompt を組み立てる(昇順・LLM に数値を渡さない)。 */
export function buildClusterPrompt(
  existing: readonly TopicRef[],
  materials: readonly TopicMaterial[],
): string {
  const topicLines =
    existing.length > 0
      ? existing.map((t) => `- ${t.topic}(${t.label})`).join("\n")
      : "(まだ無し。今回がはじめての生成)";
  const materialLines = materials
    .map((m) =>
      m.kind === "kb-entry"
        ? `- ${m.id} [KB] ${m.title}${m.domain !== undefined ? ` / domain: ${m.domain}` : ""}${
            m.tags.length > 0 ? ` / tags: ${m.tags.join(", ")}` : ""
          }`
        : `- ${m.id} [repo] ${m.repo}`,
    )
    .join("\n");
  return [
    "material をトピックへ割り当ててください。",
    "--- 既存トピック一覧ここから ---",
    topicLines,
    "--- 既存トピック一覧ここまで ---",
    "--- material 一覧ここから ---",
    materialLines,
    "--- material 一覧ここまで ---",
  ].join("\n");
}

/** 出力の参照整合をコードで検証する(問題の列挙。空 = OK)。 */
export function validateClustering(
  result: ClusteringResult,
  materialIds: ReadonlySet<string>,
  existing: readonly TopicRef[],
): string[] {
  const issues: string[] = [];
  const existingIds = new Set(existing.map((t) => t.topic));
  const newIds = new Set<string>();
  for (const t of result.new_topics) {
    if (existingIds.has(t.topic)) {
      issues.push(`new_topics の "${t.topic}" は既存トピックと重複しています(改名・再定義は不可)`);
    }
    if (newIds.has(t.topic)) issues.push(`new_topics の "${t.topic}" が重複しています`);
    newIds.add(t.topic);
  }
  const known = new Set([...existingIds, ...newIds]);
  const assigned = new Set<string>();
  for (const a of result.assignments) {
    if (!materialIds.has(a.material_id)) {
      issues.push(`assignments の material_id "${a.material_id}" は入力に存在しません`);
    }
    if (!known.has(a.topic)) {
      issues.push(`assignments の topic "${a.topic}" は既存にも new_topics にもありません`);
    }
    if (assigned.has(a.material_id)) {
      issues.push(`material "${a.material_id}" が複数回割り当てられています`);
    }
    assigned.add(a.material_id);
  }
  return issues;
}

/** クラスタリングの最終結果(検証済み)。 */
export interface ClusterOutcome {
  /** material.id → topic id。 */
  assignments: ReadonlyMap<string, string>;
  /** topic id → label(既存の引き継ぎ + 新設)。 */
  topicLabels: ReadonlyMap<string, string>;
  /** 割り当てられなかった material.id(レポートに列挙・silent drop しない)。 */
  unassigned: readonly string[];
}

export type ClusterSearchFn = (
  opts: AgentSearchOptions<ClusteringResult>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<ClusteringResult>>;

export interface ClusterDeps {
  promptStore: PromptStore;
  search?: ClusterSearchFn;
  usage?: UsageRecorder;
  retry?: RetryOptions;
  timeoutMs?: number;
  /** Agent SDK の cwd(ツール無し単発だが必須項目)。KB clone ルート。 */
  cwd: string;
}

/**
 * 増分クラスタリングを実行する(deep・ツール無し単発)。
 * 後検証の違反は是正フィードバック付きで 1 回だけ再試行 → それでも違反なら throw(fail-loud)。
 */
export async function runClustering(
  existing: readonly TopicRef[],
  materials: readonly TopicMaterial[],
  deps: ClusterDeps,
): Promise<{ value: ClusterOutcome; usage: Usage }> {
  const search: ClusterSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("expertise", "cluster", deps.promptStore);
  const basePrompt = buildClusterPrompt(existing, materials);
  const materialIds = new Set(materials.map((m) => m.id));

  const attempt = (userPrompt: string): Promise<AgentSearchResult<ClusteringResult>> =>
    withRetry(
      () =>
        search(
          {
            app: "expertise-mapper",
            role: prompt.role, // prompt frontmatter(deep)。直書きしない
            systemPrompt: prompt.body,
            prompt: userPrompt,
            cwd: deps.cwd,
            outputSchema: clusteringResultSchema,
            allowedTools: [],
            timeoutMs: deps.timeoutMs ?? 300_000,
          },
          { usage },
        ),
      { maxRetries: 1, ...deps.retry },
    );

  let res = await attempt(basePrompt);
  let issues = validateClustering(res.value, materialIds, existing);
  let totalUsage = res.usage;
  if (issues.length > 0) {
    // 是正フィードバック付きの再試行は 1 回だけ(コスト上限・§7.1)。
    res = await attempt(
      [
        basePrompt,
        "--- 前回出力の問題(すべて修正して再出力すること) ---",
        ...issues.map((i) => `- ${i}`),
      ].join("\n"),
    );
    issues = validateClustering(res.value, materialIds, existing);
    totalUsage = {
      inputTokens: totalUsage.inputTokens + res.usage.inputTokens,
      outputTokens: totalUsage.outputTokens + res.usage.outputTokens,
    };
    if (issues.length > 0) {
      throw new Error(`クラスタリング出力の検証に失敗しました(再試行後): ${issues.join(" / ")}`);
    }
  }

  const assignments = new Map<string, string>();
  for (const a of res.value.assignments) assignments.set(a.material_id, a.topic);
  const topicLabels = new Map<string, string>();
  for (const t of existing) topicLabels.set(t.topic, t.label); // 既存 label は必ず引き継ぐ(rename 不可)
  for (const t of res.value.new_topics) {
    if (!topicLabels.has(t.topic)) topicLabels.set(t.topic, t.label);
  }
  const unassigned = materials.map((m) => m.id).filter((id) => !assignments.has(id));
  return { value: { assignments, topicLabels, unassigned }, usage: totalUsage };
}
