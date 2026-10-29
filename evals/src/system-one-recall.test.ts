/**
 * System One の検索再現率(ADR-0041 D7・design.md §5.4 の 3 番目の基準の信号)。
 * golden-qa の期待出典(github_file)が、runSystemOne の候補の上位 8 件(「中」の一覧の上限)に入る率を測る。
 * 実モデル・ネットワークなし(qa-corpus は synthetic・ADR-0002)。
 *
 * 2026-10-08 の実測(初期重み): 全体 10/12 = 0.833(取りこぼしはコードのリポの文書 2 件 = gq-005 / gq-006。
 * カタログは KB と議事録だけなので設計どおり)、KB・議事録に限ると 10/10 = 1.0。
 * 床は実測から余裕を引いた値(全体 0.75・KB/議事録 0.9)。
 */
import { loadDefaultWeights, runSystemOne } from "@stratum/discord-bot/system-one";
import { describe, expect, it } from "vitest";
import {
  catalogOf,
  GOLDEN_NOW_MS,
  kindOfCitation,
  loadGolden,
  QA_CORPUS_DIR,
  QA_CORPUS_REPOS,
} from "./system-one-golden.js";

const TOP_K = 8;

describe("System One の検索再現率(golden-qa + qa-corpus)", () => {
  it("期待出典が候補の上位に入る率が床以上・答えの無い質問は前置きしない", async () => {
    const catalog = await catalogOf(QA_CORPUS_DIR, QA_CORPUS_REPOS);
    const weights = loadDefaultWeights();
    let expected = 0;
    let found = 0;
    let expectedInScope = 0;
    let foundInScope = 0;
    const rows: string[] = [];
    for (const g of loadGolden()) {
      const run = await runSystemOne({
        question: g.question,
        catalog,
        weights,
        nowMs: GOLDEN_NOW_MS,
      });
      const top = new Set(
        run.ranked.slice(0, TOP_K).map((x) => `${x.candidate.repo}:${x.candidate.path}`),
      );
      const files = g.expected_sources.filter((s) => s.kind === "github_file");
      let hit = 0;
      for (const s of files) {
        const ok = top.has(`${s.repo}:${s.path}`);
        const inScope = kindOfCitation(s) !== "code";
        expected += 1;
        if (ok) found += 1;
        if (inScope) {
          expectedInScope += 1;
          if (ok) foundInScope += 1;
        }
        if (ok) hit += 1;
      }
      rows.push(
        `${g.id} gate=${run.gate} p=${run.decisions.answerableFromCandidates.p.toFixed(2)} ` +
          `hit=${hit}/${files.length} ${run.elapsedMs}ms`,
      );
      if (g.not_found) {
        // 答えが無い質問で「高」を出さない(探索を短くして誤誘導しない)。
        expect(run.gate).not.toBe("high");
      }
    }
    const recall = found / expected;
    const recallInScope = foundInScope / expectedInScope;
    console.log(
      `System One 検索再現率: 全体 ${found}/${expected} = ${recall.toFixed(3)}・KB/議事録 ${foundInScope}/${expectedInScope} = ${recallInScope.toFixed(3)}\n${rows.join("\n")}`,
    );
    expect(recall).toBeGreaterThanOrEqual(0.75);
    expect(recallInScope).toBeGreaterThanOrEqual(0.9);
  });
});
