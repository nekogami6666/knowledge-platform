/**
 * 質問リスト生成(design.md §6.6 ⑤-b step2)。deep モデルが KB clone を agentic read
 * (Read/Grep/Glob のみ・§9.5)して、当該トピックの既存ナレッジ・議事録由来エントリを踏まえ、
 * **まだ文書化されていない穴**を突く質問 10〜15 問を生成する。
 * プロンプトは prompts/interview/questions.md(role: deep・§8.1)。runAgentSearch は seam(注入)。
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

/** LLM 出力契約(kb entry の再定義ではない中間スキーマ)。件数はプロンプトで 10〜15 に誘導し、
 *  スキーマは 5〜20 で受ける(境界ずれで run を落とさない)。 */
export const questionKitSchema = z.object({
  /** 面談の狙い(2〜3 文。既存ナレッジの現状と、この面談で埋めたい穴)。 */
  intro: z.string().min(1),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        /** どの「文書化されていない穴」を突くか(聞き手が深掘り判断に使う)。 */
        aim: z.string().min(1),
      }),
    )
    .min(5)
    .max(20),
});
export type QuestionKit = z.infer<typeof questionKitSchema>;

export type QuestionSearchFn = (
  opts: AgentSearchOptions<QuestionKit>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<QuestionKit>>;

export interface QuestionDeps {
  promptStore: PromptStore;
  /** Agent SDK の cwd(KB clone ルート。ここを Read/Grep/Glob で読む)。 */
  cwd: string;
  search?: QuestionSearchFn;
  usage?: UsageRecorder;
  retry?: RetryOptions;
  timeoutMs?: number;
}

export function buildQuestionsPrompt(person: string, topic: string): string {
  return [
    `対象者: ${person}(GitHub ユーザ名)`,
    `トピック: ${topic}`,
    "",
    "カレントディレクトリは knowledge-base の clone です。質問を作る前に必ず調べること:",
    "- `knowledge/` の当該トピックに近い domain のエントリ(既に文書化されている内容 — これは聞かない)",
    "- `expertise/expertise.yaml` と `expertise/reports/`(対象者の evidence とバス係数)",
    "- `questions/open/`(未回答の問い — 面談で拾えるものは質問に含めてよい)",
    "- `interviews/`(過去の面談 — 重複を避ける)",
    "調査結果を踏まえ、まだ文書化されていない穴を突く質問リストを 10〜15 問生成してください。",
  ].join("\n");
}

/** 質問キットを生成する(role: deep・agentic read・§6.6 ⑤-b)。 */
export async function generateQuestions(
  person: string,
  topic: string,
  deps: QuestionDeps,
): Promise<{ value: QuestionKit; usage: Usage }> {
  const search: QuestionSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("interview", "questions", deps.promptStore);
  return withRetry(
    () =>
      search(
        {
          app: "interview-kit",
          role: prompt.role, // prompt frontmatter(deep)。直書きしない
          systemPrompt: prompt.body,
          prompt: buildQuestionsPrompt(person, topic),
          cwd: deps.cwd,
          outputSchema: questionKitSchema,
          // allowedTools は既定(Read/Grep/Glob)のまま = agentic read(§9.5)。
          timeoutMs: deps.timeoutMs ?? 300_000,
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
}

/**
 * ファイル名/ブランチ名用スラグ(extractor/src/slug.ts と同じ規則の複製。共有パッケージ化は
 * logger と同様に別 PR)。日本語は ASCII 化で空になりうるため "x" にフォールバック。
 */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s.length > 0 ? s : "x";
}

/** キットの置き場所(KB リポ相対)。extractor の interviews ソースからは kits/ ごと除外される(PR-I1)。 */
export function kitPath(person: string, topic: string): string {
  return `interviews/kits/${slugify(person)}-${slugify(topic)}.md`;
}

/** 質問キットの Markdown(interviews/kits/ に置く原本。ナレッジエントリではないので frontmatter 不要)。 */
export function buildKitMarkdown(
  person: string,
  topic: string,
  kit: QuestionKit,
  generatedAt: string,
): string {
  const items = kit.questions.flatMap((q, i) => [
    `${i + 1}. **${q.question}**`,
    `   - ねらい: ${q.aim}`,
  ]);
  return [
    `# インタビューキット: ${person} × ${topic}`,
    "",
    `- 対象者: ${person}`,
    `- トピック: ${topic}`,
    `- 生成: ${generatedAt}(interview-kit・§6.6 ⑤-b)`,
    "",
    kit.intro,
    "",
    "## 質問リスト",
    "",
    ...items,
    "",
    "## 進め方(§6.6 ⑤-b)",
    "",
    "- 聞き手 + 対象者の 2 名で 30〜60 分の音声面談(録音は既存基盤・QB-Meeting-Ops)",
    "- 文字起こしを `interviews/` に保存すると extractor が自動で複数エントリ化する(kits/ 配下は対象外)",
    "",
  ].join("\n");
}
