/**
 * 議事録1ファイル → 抽出候補(design.md §6.3 step2)。
 * 全 AI は Claude on AWS の Agent SDK 経由(ADR-0009)。抽出は**ツール無し単発**
 * (`allowedTools: []`)で議事録本文を prompt にインラインで渡す(エージェント探索不要・§9.5:
 * 他リポへ書く能力を構造的に持たせない)。プロンプトは prompts/extractor/extract.md(role:standard)。
 * runAgentSearch は seam(注入)で、ユニットテストは fake で鍵・ネットワーク不要。
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
import { type ExtractionResult, extractionResultSchema } from "./candidate.js";

/** runAgentSearch の差し替え seam(ExtractionResult 固定。テストの fake が容易)。 */
export type ExtractSearchFn = (
  opts: AgentSearchOptions<ExtractionResult>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<ExtractionResult>>;

export interface ExtractDeps {
  /** プロンプトローダ(createFsPromptStore)。 */
  promptStore: PromptStore;
  /** runAgentSearch の差し替え(既定=実)。 */
  search?: ExtractSearchFn;
  /** usage 記録(既定 no-op)。 */
  usage?: UsageRecorder;
  /** withRetry オプション(テストで sleep 注入)。既定 maxRetries:1(§6.2)。 */
  retry?: RetryOptions;
  /** LLM タイムアウト(ms)。実議事録は密で既定 120s を超えうるため既定 300s。 */
  timeoutMs?: number;
  /** 既存 domain の一覧(⑱・§2-C)。プロンプトに提示して learning の domain 再利用を促す(乱立抑制)。 */
  existingDomains?: readonly string[];
  /** プロンプト名(prompts/extractor/<name>.md)。既定 "extract"。interviews は "extract-interview"(PR-I1)。 */
  promptName?: string;
}

export interface MinutesInput {
  /** "org/minutes"。 */
  repo: string;
  /** repo 相対パス(例 "2026/06/2026-06-10-hw-weekly.md")。 */
  path: string;
  /** 議事録本文(呼び出し側=F1c が clone から読む)。 */
  content: string;
  /** Agent SDK の cwd(ソース clone ルート)。ツール無しなので実体探索はしない。 */
  cwd: string;
  /** 文書の種類ラベル(prompt の導入文に使う)。既定 "会議議事録"。 */
  label?: string;
}

/** 各行頭に `L{n}: ` を付け、LLM が根拠の行範囲(lines)を確実に引用できるようにする。 */
export function numberLines(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `L${i + 1}: ${line}`)
    .join("\n");
}

/** 議事録本文を user prompt に組み立てる(本文はインライン。ツールで読みにいかない)。 */
export function buildExtractPrompt(
  input: MinutesInput,
  existingDomains: readonly string[] = [],
): string {
  const domainLine =
    existingDomains.length > 0
      ? `既存 domain(learning の domain はなるべくこの中から選ぶ・無ければ新設可): ${existingDomains.join(", ")}`
      : "既存 domain: (まだ無し。適切な粒度で新設してよい)";
  const label = input.label ?? "会議議事録";
  return [
    `以下は1つの${label}です。決定 / 学び / 未解決の問い を抽出してください。`,
    `repo: ${input.repo}`,
    `path: ${input.path}`,
    domainLine,
    "各行頭の `L{n}:` は行番号です。根拠の行範囲を lines(例 L12-L18)で示してください。",
    "--- 本文ここから ---",
    numberLines(input.content),
    "--- 本文ここまで ---",
  ].join("\n");
}

/** ソース 1 ファイルから抽出候補を得る(role:standard・ツール無し単発・§6.3)。 */
export async function extractFromMinutes(
  input: MinutesInput,
  deps: ExtractDeps,
): Promise<{ value: ExtractionResult; usage: Usage }> {
  const search: ExtractSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("extractor", deps.promptName ?? "extract", deps.promptStore);
  return withRetry(
    () =>
      search(
        {
          app: "extractor",
          role: prompt.role, // prompt frontmatter(standard)。"standard" を直書きしない
          systemPrompt: prompt.body,
          prompt: buildExtractPrompt(input, deps.existingDomains ?? []),
          cwd: input.cwd,
          outputSchema: extractionResultSchema,
          allowedTools: [],
          timeoutMs: deps.timeoutMs ?? 300_000,
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
}
