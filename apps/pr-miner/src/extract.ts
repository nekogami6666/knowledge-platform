/**
 * マージ済み PR 1 件 → 抽出候補(design.md §6.4 ③-c)。
 * 入力 = PR タイトル/本文/コメント/変更ファイルサマリを prompt にインラインで渡す(ツール無し単発・
 * extractor/extract.ts と同思想)。**出力は extractor の extractionResultSchema を再利用**するため、
 * 得た候補はそのまま reconcile / materialize に流せる(§6.3 と同じ器)。
 * プロンプトは prompts/pr-miner/extract.md(role:standard)。「コードは Git にある。判断と理由だけを取る」。
 */
import { type ExtractionResult, extractionResultSchema } from "@stratum/extractor/candidate";
import type { PrCommentItem, PrFileSummary } from "@stratum/gh-client";
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

/** runAgentSearch の差し替え seam(ExtractionResult 固定。テストの fake が容易)。 */
export type ExtractSearchFn = (
  opts: AgentSearchOptions<ExtractionResult>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<ExtractionResult>>;

export interface PrExtractDeps {
  promptStore: PromptStore;
  search?: ExtractSearchFn;
  usage?: UsageRecorder;
  retry?: RetryOptions;
  timeoutMs?: number;
  /** 既存 domain(learning の domain 再利用を促す・§2-C)。 */
  existingDomains?: readonly string[];
  /** Agent SDK の cwd(ツール無し単発だが必須項目)。KB clone ルート。 */
  cwd: string;
}

/** マイニング対象 PR(gh-client の読み取り API が返す素材をまとめたもの)。 */
export interface PrInput {
  /** "org/name"。 */
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string | null;
  comments: readonly PrCommentItem[];
  files: readonly PrFileSummary[];
}

/** 巨大 PR 対策の上限(プロンプトが膨らみすぎてコスト/精度を落とさないための足切り)。 */
export const MAX_BODY_CHARS = 8_000;
export const MAX_COMMENTS = 40;
export const MAX_FILES = 100;

/** 変更ファイルを "path (status +add -del)" の一覧に(diff 本文は含めない・③-c)。 */
function fileLines(files: readonly PrFileSummary[]): string {
  const shown = files.slice(0, MAX_FILES);
  const omitted = files.length - shown.length;
  const lines = shown.map((f) => `- ${f.path}(${f.status} +${f.additions} -${f.deletions})`);
  if (omitted > 0) lines.push(`- (ほか ${omitted} ファイル省略)`);
  return lines.join("\n");
}

function commentLines(comments: readonly PrCommentItem[]): string {
  const shown = comments.slice(0, MAX_COMMENTS);
  const omitted = comments.length - shown.length;
  const lines = shown.map((c) => `[${c.author ?? "?"}] ${c.body}`);
  if (omitted > 0) lines.push(`(ほか ${omitted} コメント省略)`);
  return lines.join("\n");
}

/** PR の素材を user prompt に組み立てる(インライン。ツールで読みにいかない)。 */
export function buildPrExtractPrompt(
  input: PrInput,
  existingDomains: readonly string[] = [],
): string {
  const domainLine =
    existingDomains.length > 0
      ? `既存 domain(learning の domain はなるべくこの中から選ぶ・無ければ新設可): ${existingDomains.join(", ")}`
      : "既存 domain: (まだ無し。適切な粒度で新設してよい)";
  const body =
    input.body.length > MAX_BODY_CHARS ? `${input.body.slice(0, MAX_BODY_CHARS)}…` : input.body;
  return [
    "以下は1つのマージ済み Pull Request です。設計判断・ハマりどころ(と、その理由)を抽出してください。",
    "コードそのもの・diff は知識化しません。変更ファイル一覧は「何をどこで変えたか」の手掛かりに留めます。",
    `repo: ${input.repo}`,
    `PR: #${input.number} ${input.title}`,
    `作成者: ${input.author ?? "(不明)"}`,
    domainLine,
    "--- PR 本文ここから ---",
    body.length > 0 ? body : "(本文なし)",
    "--- PR 本文ここまで ---",
    "--- コメントここから ---",
    input.comments.length > 0 ? commentLines(input.comments) : "(コメントなし)",
    "--- コメントここまで ---",
    "--- 変更ファイル(サマリ)ここから ---",
    input.files.length > 0 ? fileLines(input.files) : "(変更ファイルなし)",
    "--- 変更ファイル(サマリ)ここまで ---",
  ].join("\n");
}

/** 1 PR から抽出候補を得る(role:standard・ツール無し単発・§6.4 ③-c)。 */
export async function extractFromPr(
  input: PrInput,
  deps: PrExtractDeps,
): Promise<{ value: ExtractionResult; usage: Usage }> {
  const search: ExtractSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("pr-miner", "extract", deps.promptStore);
  return withRetry(
    () =>
      search(
        {
          app: "pr-miner",
          role: prompt.role, // prompt frontmatter(standard)。直書きしない
          systemPrompt: prompt.body,
          prompt: buildPrExtractPrompt(input, deps.existingDomains ?? []),
          cwd: deps.cwd,
          outputSchema: extractionResultSchema,
          allowedTools: [],
          timeoutMs: deps.timeoutMs ?? 300_000,
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
}
