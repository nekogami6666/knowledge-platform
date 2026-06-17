/**
 * 出典一致(citation-match)スコアリング(design.md §10.2(a) / §6.2 AC1)。純粋関数のみ。
 *
 * マッチ規則(v1):
 * - github_file: repo + path 一致(**lines は無視** — 行精度は v1 では問わない)。
 * - github_pr / github_issue: repo + number 一致。
 * - discord: url 一致。
 * - NOT_FOUND 問題(not_found:true): 回答が notFound===true かつ citations 空なら一致。
 * - subset セマンティクス: expected_sources を**全て**含めば一致(余分な引用は減点しない)。
 */
import type { QaAnswer, QaCitation } from "@stratum/discord-bot/qa";
import type { GoldenQa } from "./golden.js";

/** expected 1 件が returned 集合に含まれるか(kind 別等価)。 */
export function citationMatches(expected: QaCitation, returned: readonly QaCitation[]): boolean {
  return returned.some((r) => {
    if (expected.kind === "github_file" && r.kind === "github_file") {
      return r.repo === expected.repo && r.path === expected.path;
    }
    if (
      (expected.kind === "github_pr" || expected.kind === "github_issue") &&
      r.kind === expected.kind
    ) {
      return r.repo === expected.repo && r.number === expected.number;
    }
    if (expected.kind === "discord" && r.kind === "discord") {
      return r.url === expected.url;
    }
    return false;
  });
}

export interface QaResult {
  id: string;
  answer: QaAnswer;
}

export interface QuestionScore {
  id: string;
  matched: boolean;
  /** NOT_FOUND が期待されていた問題か(レポート用)。 */
  notFoundExpected: boolean;
}

export interface RunScore {
  perQuestion: QuestionScore[];
  passCount: number;
  total: number;
  /** passCount / total(0..1)。 */
  citationMatchRate: number;
}

/** 1 問を採点する。 */
export function scoreQuestion(golden: GoldenQa, answer: QaAnswer): QuestionScore {
  if (golden.not_found) {
    return {
      id: golden.id,
      matched: answer.notFound === true && answer.citations.length === 0,
      notFoundExpected: true,
    };
  }
  const matched =
    answer.notFound !== true &&
    golden.expected_sources.every((e) => citationMatches(e, answer.citations));
  return { id: golden.id, matched, notFoundExpected: false };
}

/** golden 全件を results(id→QaAnswer)と突合して採点する。result 欠落は不一致扱い。 */
export function scoreRun(golden: readonly GoldenQa[], results: readonly QaResult[]): RunScore {
  const byId = new Map(results.map((r) => [r.id, r.answer]));
  const perQuestion = golden.map<QuestionScore>((g) => {
    const answer = byId.get(g.id);
    if (answer === undefined) {
      return { id: g.id, matched: false, notFoundExpected: g.not_found };
    }
    return scoreQuestion(g, answer);
  });
  const passCount = perQuestion.filter((q) => q.matched).length;
  const total = golden.length;
  return {
    perQuestion,
    passCount,
    total,
    citationMatchRate: total === 0 ? 0 : passCount / total,
  };
}
