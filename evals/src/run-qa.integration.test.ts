/**
 * golden eval の実行(design.md §10.2(a) / §6.2 AC1)。
 *
 * **ANTHROPIC_API_KEY があるときだけ実行**(無ければ skip → Stop フック/CI は緑のまま。
 * better-sqlite3 と同じ skipIf パターン)。実 Claude が synthetic コーパスを agentic search し、
 * 出典一致 8/10 以上 と NOT_FOUND ケースを確認する。ADR-0002: コーパスは synthetic のみ。
 *
 * 実行本体は run-qa.ts の runGoldenEval(週次 CLI と共用)。本テストは PR ゲートとしての assert を担う。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGoldenEval } from "./run-qa.js";

const PROMPTS_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));
const CORPUS_DIR = fileURLToPath(new URL("../fixtures/qa-corpus", import.meta.url));
const GOLDEN = readFileSync(fileURLToPath(new URL("../golden-qa.yaml", import.meta.url)), "utf8");

// corpus の subdir ↔ repo(org/name)対応(本番と同じ buildRepoManifest を runGoldenEval が使う)。
const REPOS = [
  { repo: "org/minutes", dir: "minutes" },
  { repo: "org/dispenser-fw", dir: "dispenser-fw" },
  { repo: "org/knowledge-base", dir: "knowledge-base" },
];

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "golden eval (real Claude, synthetic corpus)",
  () => {
    it("出典一致 >= 8/10(§6.2 AC1)+ NOT_FOUND ケース成立 + 妥当性 soft", async () => {
      const { citation, validity, results } = await runGoldenEval({
        goldenYaml: GOLDEN,
        promptsDir: PROMPTS_DIR,
        corpusDir: CORPUS_DIR,
        repos: REPOS,
      });
      // 失敗時に内訳が見えるよう出す(§8.1 PR 貼付用)。
      console.log("citation:", JSON.stringify(citation, null, 2));
      console.log("validity:", JSON.stringify(validity, null, 2));

      expect(citation.passCount).toBeGreaterThanOrEqual(8);
      expect(results.find((r) => r.id === "gq-010")?.answer.notFound).toBe(true);
      // soft: deep 判定のばらつきで suite を flake させない。
      expect(validity.counts.bad).toBeLessThanOrEqual(2);
    }, 900_000);
  },
);
