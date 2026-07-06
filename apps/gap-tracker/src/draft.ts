/**
 * gap 回答 → KnowledgeEntry 草案(design.md §6.5 step4 / PR-D3a)。
 * 全 AI は Claude on AWS の Agent SDK 経由(ADR-0009)。草案は**ツール無し単発**(`allowedTools: []`)で
 * 質問と回答を prompt にインラインで渡す(エージェント探索不要・§9.5)。プロンプトは prompts/gap/entry.md
 * (role:standard)。runAgentSearch は seam(注入)で、ユニットは fake で鍵・ネットワーク不要。
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
import { type AnswerEntryCandidate, answerEntryCandidateSchema } from "./answer.js";

/** runAgentSearch の差し替え seam(AnswerEntryCandidate 固定。fake が容易)。 */
export type DraftSearchFn = (
  opts: AgentSearchOptions<AnswerEntryCandidate>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<AnswerEntryCandidate>>;

export interface DraftDeps {
  promptStore: PromptStore;
  /** runAgentSearch の差し替え(既定=実)。 */
  search?: DraftSearchFn;
  usage?: UsageRecorder;
  /** withRetry オプション(既定 maxRetries:1)。 */
  retry?: RetryOptions;
  timeoutMs?: number;
}

export interface DraftInput {
  /** 元の質問(questions/open/<id>.md の question)。 */
  question: string;
  /** 担当者の回答本文。 */
  answer: string;
  /** Agent SDK の cwd(KB clone。ツール無しなので実体探索はしない)。 */
  cwd: string;
  /** 既存 domain(乱立抑制・§6.5)。KB clone から都度算出して渡す。 */
  existingDomains?: readonly string[];
}

/** 質問 + 回答を user prompt に組み立てる(本文はインライン。ツールで読みにいかない)。 */
export function buildDraftPrompt(input: DraftInput): string {
  const existingDomains = input.existingDomains ?? [];
  const domainLine =
    existingDomains.length > 0
      ? `既存 domain(なるべくこの中から選ぶ・無ければ新設可): ${existingDomains.join(", ")}`
      : "既存 domain: (まだ無し。適切な粒度で新設してよい)";
  return [
    "以下は社内で聞かれた質問と、担当者からの回答です。回答内容を 1 件のナレッジ記事に整理してください。",
    domainLine,
    "--- 質問 ---",
    input.question,
    "--- 回答 ---",
    input.answer,
    "--- ここまで ---",
  ].join("\n");
}

/** 1 件の gap 回答からナレッジ草案を得る(role:standard・ツール無し単発・§6.5 step4)。 */
export async function draftEntry(
  input: DraftInput,
  deps: DraftDeps,
): Promise<{ value: AnswerEntryCandidate; usage: Usage }> {
  const search: DraftSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("gap", "entry", deps.promptStore);
  return withRetry(
    () =>
      search(
        {
          app: "gap-tracker",
          role: prompt.role, // prompt frontmatter(standard)。直書きしない
          systemPrompt: prompt.body,
          prompt: buildDraftPrompt(input),
          cwd: input.cwd,
          outputSchema: answerEntryCandidateSchema,
          allowedTools: [],
          timeoutMs: deps.timeoutMs ?? 120_000,
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
}
