/**
 * golden eval の実行(design.md §10.2(a) / §6.2 AC1)。
 *
 * **ANTHROPIC_API_KEY があるときだけ実行**(無ければ skip → Stop フック/CI は緑のまま。
 * better-sqlite3 と同じ skipIf パターン)。実 Claude が synthetic コーパスを agentic search し、
 * 出典一致 8/10 以上 と NOT_FOUND ケースを確認する。ADR-0002: コーパスは synthetic のみ。
 *
 * 注: 実 /ask では「どのファイルがどの repo(org/name)か」を Bot がプロンプトに与える必要がある
 * (現状 ask.ts は prompt+question のみ渡す = 既知の follow-up)。本テストは評価ハーネスとして
 * リポジトリ対応表を systemPrompt に前置し、エージェントが正しい repo/path を引用できる前提で測る。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createQaSearch } from "@stratum/discord-bot/qa";
import { createFsPromptStore, loadPrompt } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import { loadGoldenQa } from "./golden.js";
import { type JudgedQuestion, judgeAnswer, scoreValidity } from "./judge.js";
import { type QaResult, scoreRun } from "./score.js";

const PROMPTS_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));
const CORPUS_DIR = fileURLToPath(new URL("../fixtures/qa-corpus", import.meta.url));
const GOLDEN = readFileSync(fileURLToPath(new URL("../golden-qa.yaml", import.meta.url)), "utf8");

// 評価ハーネス用: コーパスの subdir ↔ repo(org/name)対応表を systemPrompt に前置する。
const REPO_MANIFEST = [
  "## 検索対象リポジトリ(このコーパスでの対応)",
  "- org/minutes → サブディレクトリ `minutes/`",
  "- org/dispenser-fw → サブディレクトリ `dispenser-fw/`",
  "- org/knowledge-base → サブディレクトリ `knowledge-base/`",
  "引用の repo にはこの org/name を使い、path は各サブディレクトリ配下からの相対パスにすること。",
  "",
].join("\n");

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "golden eval (real Claude, synthetic corpus)",
  () => {
    it("出典一致 >= 8/10(§6.2 AC1)+ NOT_FOUND ケース成立", async () => {
      const golden = loadGoldenQa(GOLDEN);
      const promptStore = createFsPromptStore(PROMPTS_DIR);
      const prompt = await loadPrompt("qa", "answer", promptStore);
      const systemPrompt = `${REPO_MANIFEST}\n${prompt.body}`;
      const search = createQaSearch();

      const results: QaResult[] = [];
      for (const g of golden) {
        const { value } = await search({ systemPrompt, question: g.question, cwd: CORPUS_DIR });
        results.push({ id: g.id, answer: value });
      }

      const score = scoreRun(golden, results);
      // 失敗時に内訳が見えるよう per-question を出す(§8.1 PR 貼付用)。
      console.log("citation:", JSON.stringify(score, null, 2));
      expect(score.passCount).toBeGreaterThanOrEqual(8);

      const notFound = results.find((r) => r.id === "gq-010")?.answer;
      expect(notFound?.notFound).toBe(true);

      // §10.2(b) 回答妥当性: deep モデルで各回答を 3 段階採点(soft 指標。AC1 のハードゲートにはしない)。
      const judgePrompt = await loadPrompt("evals", "judge", promptStore);
      const byId = new Map(results.map((r) => [r.id, r.answer]));
      const judged: JudgedQuestion[] = [];
      for (const g of golden) {
        const answer = byId.get(g.id);
        if (answer === undefined) continue;
        // soft 指標: 1 問の judge 失敗(STRUCTURED_PARSE 等の非リトライ throw)で suite 全体を
        // 落とさない。失敗は level 0(bad)として記録し、blast radius を 1 問に留める。
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
        } catch (err) {
          console.warn(`judge failed for ${g.id}:`, err instanceof Error ? err.message : err);
          judged.push({ id: g.id, level: 0 });
        }
      }
      const validity = scoreValidity(judged);
      console.log("validity:", JSON.stringify(validity, null, 2));
      // soft: deep 判定のばらつきで suite を flake させない。bad は 2/10 以下を期待。
      expect(validity.counts.bad).toBeLessThanOrEqual(2);
    }, 900_000); // 10 問 × 実エージェント(各最大 120s)。
  },
);
