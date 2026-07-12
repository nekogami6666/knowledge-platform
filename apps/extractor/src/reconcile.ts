/**
 * 抽出候補と既存 knowledge-base の突合(design.md §6.3 step3)。
 * 候補1件ごとに Claude on AWS の agentic search(既定 allowedTools=Read/Grep/Glob)で KB clone を探索し、
 * new / duplicate / contradiction を判定する(1 候補=1 コンテキスト=blast-radius-1)。
 * D2: 未解決の問い(open_question)は突合せず常に new(LLM 呼び出し無し・gap-tracker の領域)。
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
import type { DecisionCandidate, LearningCandidate, OpenQuestionCandidate } from "./candidate.js";
import { type Verdict, verdictSchema } from "./verdict.js";

export type Candidate = DecisionCandidate | LearningCandidate | OpenQuestionCandidate;

/** runAgentSearch の差し替え seam(Verdict 固定)。 */
export type ReconcileSearchFn = (
  opts: AgentSearchOptions<Verdict>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<Verdict>>;

export interface ReconcileDeps {
  promptStore: PromptStore;
  search?: ReconcileSearchFn;
  usage?: UsageRecorder;
  retry?: RetryOptions;
  /** LLM タイムアウト(ms)。既定 300s(実 KB の agentic search が既定 120s を超えうる)。 */
  timeoutMs?: number;
  /** コスト記録のアプリ名(§7.3)。既定 "extractor"。pr-miner 等が流用する際に上書きする。 */
  app?: string;
}

/** 候補を突合プロンプト用のテキストに要約する(agent が KB を検索する手掛かり)。 */
export function candidateSummary(c: Candidate): string {
  if (c.kind === "decision") {
    return [
      "種別: 決定",
      `タイトル: ${c.title}`,
      `内容: ${c.decision}`,
      c.rationale ? `理由: ${c.rationale}` : "",
    ]
      .filter((l) => l.length > 0)
      .join("\n");
  }
  if (c.kind === "learning") {
    return [
      `種別: 学び(${c.entryType})`,
      `ドメイン: ${c.domain}`,
      `タイトル: ${c.title}`,
      `内容: ${c.body}`,
    ].join("\n");
  }
  return ["種別: 未解決の問い", `タイトル: ${c.title}`, `内容: ${c.body}`].join("\n");
}

/** 候補1件を既存 KB に突合して verdict を返す。 */
export async function reconcileCandidate(
  candidate: Candidate,
  kbCwd: string,
  deps: ReconcileDeps,
): Promise<{ value: Verdict; usage: Usage }> {
  // D2: 未解決の問いは突合せず新規扱い(gap-tracker が扱う)。LLM を呼ばない。
  if (candidate.kind === "open_question") {
    return {
      value: { classification: "new", reason: "未解決の問いは突合せず新規扱い(gap-tracker 領域)" },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  const search: ReconcileSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("extractor", "reconcile", deps.promptStore);
  return withRetry(
    () =>
      search(
        {
          app: deps.app ?? "extractor",
          role: prompt.role,
          systemPrompt: prompt.body,
          prompt: candidateSummary(candidate),
          cwd: kbCwd,
          outputSchema: verdictSchema,
          timeoutMs: deps.timeoutMs ?? 300_000,
          // allowedTools は既定(Read/Grep/Glob)。KB clone を探索して既存エントリを探す。
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
}
