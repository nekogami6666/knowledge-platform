/**
 * golden eval の実行本体(design.md §10.2)。integration テストと週次 CLI が共用する。
 * 実 Claude を使う(createQaSearch / judgeAnswer)。両者とも Claude on AWS(Agent SDK)経由(ADR-0009)。
 * 呼び出し側が Claude on AWS の env(CLAUDE_CODE_USE_ANTHROPIC_AWS / ANTHROPIC_AWS_* / AWS_REGION)を用意する。
 * ADR-0002: corpus は synthetic のみ。
 */
import { buildRepoManifest, createQaSearch } from "@stratum/discord-bot/qa";
import { createFsPromptStore, loadPrompt } from "@stratum/llm";
import { loadGoldenQa } from "./golden.js";
import { type JudgedQuestion, judgeAnswer, scoreValidity, type ValidityScore } from "./judge.js";
import { type QaResult, type RunScore, scoreRun } from "./score.js";

export interface GoldenEvalInput {
  /** golden-qa.yaml の生テキスト。 */
  goldenYaml: string;
  /** prompts/ のルート(qa/answer.md・evals/judge.md を読む)。 */
  promptsDir: string;
  /** 検索対象 synthetic コーパスのルート(cwd)。 */
  corpusDir: string;
  /** subdir↔repo 対応(manifest 用)。 */
  repos: readonly { repo: string; dir: string }[];
}

export interface GoldenEvalResult {
  /** §10.2(a) 出典一致。 */
  citation: RunScore;
  /** §10.2(b) 回答妥当性(judge)。 */
  validity: ValidityScore;
  /** 生の回答(NOT_FOUND 等の追加検証用)。 */
  results: QaResult[];
}

/** golden 全件を実 Claude で評価し、出典一致 + 回答妥当性を返す。 */
export async function runGoldenEval(input: GoldenEvalInput): Promise<GoldenEvalResult> {
  const golden = loadGoldenQa(input.goldenYaml);
  const promptStore = createFsPromptStore(input.promptsDir);
  const qaPrompt = await loadPrompt("qa", "answer", promptStore);
  const manifest = buildRepoManifest(input.repos);
  const systemPrompt = manifest === "" ? qaPrompt.body : `${manifest}\n${qaPrompt.body}`;
  const search = createQaSearch();

  const results: QaResult[] = [];
  for (const g of golden) {
    const { value } = await search({ systemPrompt, question: g.question, cwd: input.corpusDir });
    results.push({ id: g.id, answer: value });
  }
  const citation = scoreRun(golden, results);

  // §10.2(b): deep モデルで回答妥当性を採点(soft)。1 問の judge 失敗は level 0 に封じ込め。
  const judgePrompt = await loadPrompt("evals", "judge", promptStore);
  const byId = new Map(results.map((r) => [r.id, r.answer]));
  const judged: JudgedQuestion[] = [];
  for (const g of golden) {
    const answer = byId.get(g.id);
    if (answer === undefined) continue;
    try {
      const verdict = await judgeAnswer(
        {
          question: g.question,
          answerPoints: g.answer_points,
          answer,
          notFoundExpected: g.not_found,
        },
        { judgePrompt },
      );
      judged.push({ id: g.id, level: verdict.level });
    } catch {
      judged.push({ id: g.id, level: 0 });
    }
  }
  const validity = scoreValidity(judged);

  return { citation, validity, results };
}
