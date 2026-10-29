/**
 * golden eval の実行本体(design.md §10.2)。integration テストと週次 CLI が共用する。
 * 実 Claude を使う(createQaSearch / judgeAnswer)。両者とも Claude on AWS(Agent SDK)経由(ADR-0009)。
 * 呼び出し側が Claude on AWS の env(CLAUDE_CODE_USE_ANTHROPIC_AWS / ANTHROPIC_AWS_* / AWS_REGION)を用意する。
 * ADR-0002: corpus は synthetic のみ。
 */
import { buildRepoManifest, createQaSearch } from "@stratum/discord-bot/qa";
import { createFsPromptStore, loadPrompt, type PromptStore } from "@stratum/llm";
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

/** /ask と同じ形の system prompt(静的な qa/answer 本文 + 後半の repo 対応表)。 */
export interface QaSystemPrompt {
  systemPrompt: string;
  systemPromptDynamic?: string;
}

/**
 * qa/answer を読み、本番 /ask(ask.ts handleAskRequest)と同じ順序で system prompt を組む
 * (本文を先頭、manifest を後半 = systemPromptDynamic)。golden eval と速度ベンチが共用する。
 */
export async function loadQaSystemPrompt(
  promptStore: PromptStore,
  repos: readonly { repo: string; dir: string }[],
): Promise<QaSystemPrompt> {
  const qaPrompt = await loadPrompt("qa", "answer", promptStore);
  const manifest = buildRepoManifest(repos);
  return {
    systemPrompt: qaPrompt.body,
    ...(manifest !== "" ? { systemPromptDynamic: manifest } : {}),
  };
}

/** golden 全件を実 Claude で評価し、出典一致 + 回答妥当性を返す。 */
export async function runGoldenEval(input: GoldenEvalInput): Promise<GoldenEvalResult> {
  const golden = loadGoldenQa(input.goldenYaml);
  const promptStore = createFsPromptStore(input.promptsDir);
  const qaSystemPrompt = await loadQaSystemPrompt(promptStore, input.repos);
  const search = createQaSearch();

  const results: QaResult[] = [];
  for (const g of golden) {
    // ADR-0035 D6: 所要時間とターン数も残す(正答率と併せて探索予算・ノブの効果を見る)。
    const t0 = performance.now();
    const { value, numTurns } = await search({
      ...qaSystemPrompt,
      question: g.question,
      cwd: input.corpusDir,
    });
    results.push({
      id: g.id,
      answer: value,
      elapsedMs: Math.round(performance.now() - t0),
      ...(numTurns !== undefined ? { numTurns } : {}),
    });
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
