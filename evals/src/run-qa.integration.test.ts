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
import { type QaResult, scoreRun } from "./score.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)); // repo root
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
      void ROOT;
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
      // 失敗時に内訳が見えるよう per-question を出す。
      console.log(JSON.stringify(score, null, 2));
      expect(score.passCount).toBeGreaterThanOrEqual(8);

      const notFound = results.find((r) => r.id === "gq-010")?.answer;
      expect(notFound?.notFound).toBe(true);
    }, 600_000); // 10 問 × 実エージェント(各最大 120s)。
  },
);
