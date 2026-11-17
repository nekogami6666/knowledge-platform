/**
 * 出典一致(citation-match)スコアリング(design.md §10.2(a) / §6.2 AC1)。純粋関数のみ。
 *
 * マッチ規則(v1):
 * - github_file: repo + path 一致(**lines は無視** — 行精度は v1 では問わない)。
 * - github_pr / github_issue: repo + number 一致。
 * - discord: url 一致。
 * - NOT_FOUND 問題(not_found:true): 回答が notFound===true かつ citations 空なら一致。
 * - subset セマンティクス: expected_sources を**全て**含めば一致(余分な引用は減点しない)。
 * - KB 経由(2026-11-09): 期待の github_file(議事録など)を直接引用していなくても、引用した KB 記事の
 *   frontmatter `sources` にその (repo, path) があれば一致とする(KB は議事録から抽出した二次資料で、出典として正しい)。
 *   KB の読み取りは呼び出し側が resolver で注入する(この関数は純粋に保つ)。直接一致だけの率は directMatchRate に別掲。
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
  /** 1 問の所要 ms(ADR-0035 D6: 探索予算の効果測定。省略可)。 */
  elapsedMs?: number;
  /** Agent SDK のターン数(同上・result に無ければ undefined)。 */
  numTurns?: number;
}

/** 引用した github_file(repo, path)が KB 記事なら、その sources のファイル参照を返す(KB でなければ [])。 */
export type KbSourcesOf = (repo: string, path: string) => readonly { repo: string; path: string }[];

export interface QuestionScore {
  id: string;
  matched: boolean;
  /** 一致の仕方。direct = 期待の出典をそのまま引用 / kb = 引用した KB 記事の sources 経由。不一致なら null。 */
  matchedVia: "direct" | "kb" | null;
  /** NOT_FOUND が期待されていた問題か(レポート用)。 */
  notFoundExpected: boolean;
}

export interface RunScore {
  perQuestion: QuestionScore[];
  passCount: number;
  total: number;
  /** passCount / total(0..1)。KB 経由の一致を含む。 */
  citationMatchRate: number;
  /** 期待の出典をそのまま引用できた率(KB 経由を含めない・プロンプトの退行を見る)。 */
  directMatchRate: number;
}

/** expected 1 件が、引用された KB 記事の sources に含まれるか。 */
function matchesViaKb(
  expected: QaCitation,
  returned: readonly QaCitation[],
  kbSourcesOf: KbSourcesOf,
): boolean {
  if (expected.kind !== "github_file") return false;
  return returned.some(
    (r) =>
      r.kind === "github_file" &&
      kbSourcesOf(r.repo, r.path).some((s) => s.repo === expected.repo && s.path === expected.path),
  );
}

/** 1 問を採点する。kbSourcesOf が無ければ直接一致だけ(従来どおり)。 */
export function scoreQuestion(
  golden: GoldenQa,
  answer: QaAnswer,
  kbSourcesOf?: KbSourcesOf,
): QuestionScore {
  if (golden.not_found) {
    const matched = answer.notFound === true && answer.citations.length === 0;
    return {
      id: golden.id,
      matched,
      matchedVia: matched ? "direct" : null,
      notFoundExpected: true,
    };
  }
  if (answer.notFound === true) {
    return { id: golden.id, matched: false, matchedVia: null, notFoundExpected: false };
  }
  const direct = golden.expected_sources.every((e) => citationMatches(e, answer.citations));
  if (direct)
    return { id: golden.id, matched: true, matchedVia: "direct", notFoundExpected: false };
  const viaKb =
    kbSourcesOf !== undefined &&
    golden.expected_sources.every(
      (e) => citationMatches(e, answer.citations) || matchesViaKb(e, answer.citations, kbSourcesOf),
    );
  return {
    id: golden.id,
    matched: viaKb,
    matchedVia: viaKb ? "kb" : null,
    notFoundExpected: false,
  };
}

/** golden 全件を results(id→QaAnswer)と突合して採点する。result 欠落は不一致扱い。 */
export function scoreRun(
  golden: readonly GoldenQa[],
  results: readonly QaResult[],
  kbSourcesOf?: KbSourcesOf,
): RunScore {
  const byId = new Map(results.map((r) => [r.id, r.answer]));
  const perQuestion = golden.map<QuestionScore>((g) => {
    const answer = byId.get(g.id);
    if (answer === undefined) {
      return { id: g.id, matched: false, matchedVia: null, notFoundExpected: g.not_found };
    }
    return scoreQuestion(g, answer, kbSourcesOf);
  });
  const passCount = perQuestion.filter((q) => q.matched).length;
  const directCount = perQuestion.filter((q) => q.matchedVia === "direct").length;
  const total = golden.length;
  return {
    perQuestion,
    passCount,
    total,
    citationMatchRate: total === 0 ? 0 : passCount / total,
    directMatchRate: total === 0 ? 0 : directCount / total,
  };
}

/** 外れた問題の一覧(通知・ログ用)。引用先は "repo:path" / "discord" / "github_pr" 等の短い形。 */
export interface MissedQuestion {
  id: string;
  notFound: boolean;
  cited: string[];
}

export function listMisses(score: RunScore, results: readonly QaResult[]): MissedQuestion[] {
  const byId = new Map(results.map((r) => [r.id, r.answer]));
  return score.perQuestion
    .filter((q) => !q.matched)
    .map((q) => {
      const a = byId.get(q.id);
      return {
        id: q.id,
        notFound: a?.notFound === true,
        cited: (a?.citations ?? []).map((c) =>
          c.kind === "github_file" ? `${c.repo}:${c.path}` : c.kind,
        ),
      };
    });
}
