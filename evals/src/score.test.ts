import type { QaAnswer, QaCitation } from "@stratum/discord-bot/qa";
import { describe, expect, it } from "vitest";
import type { GoldenQa } from "./golden.js";
import { citationMatches, scoreQuestion, scoreRun } from "./score.js";

const ans = (over: Partial<QaAnswer> = {}): QaAnswer => ({
  answer: "A",
  citations: [],
  notFound: false,
  ...over,
});

const golden = (over: Partial<GoldenQa> = {}): GoldenQa => ({
  id: "g",
  question: "q",
  expected_sources: [],
  answer_points: [],
  not_found: false,
  ...over,
});

describe("citationMatches", () => {
  it("github_file は repo+path 一致(lines は無視)", () => {
    const expected: QaCitation = { kind: "github_file", repo: "org/m", path: "a.md" };
    expect(
      citationMatches(expected, [
        { kind: "github_file", repo: "org/m", path: "a.md", lines: "L1-L2" },
      ]),
    ).toBe(true);
    expect(citationMatches(expected, [{ kind: "github_file", repo: "org/m", path: "b.md" }])).toBe(
      false,
    );
    expect(citationMatches(expected, [{ kind: "github_file", repo: "org/x", path: "a.md" }])).toBe(
      false,
    );
  });

  it("github_pr / github_issue は repo+number 一致(kind も区別)", () => {
    const pr: QaCitation = { kind: "github_pr", repo: "org/fw", number: 412 };
    expect(citationMatches(pr, [{ kind: "github_pr", repo: "org/fw", number: 412 }])).toBe(true);
    expect(citationMatches(pr, [{ kind: "github_issue", repo: "org/fw", number: 412 }])).toBe(
      false,
    );
    expect(citationMatches(pr, [{ kind: "github_pr", repo: "org/fw", number: 99 }])).toBe(false);
  });

  it("discord は url 一致", () => {
    const d: QaCitation = { kind: "discord", url: "https://discord.com/channels/1/2/3" };
    expect(
      citationMatches(d, [{ kind: "discord", url: "https://discord.com/channels/1/2/3" }]),
    ).toBe(true);
    expect(
      citationMatches(d, [{ kind: "discord", url: "https://discord.com/channels/9/9/9" }]),
    ).toBe(false);
  });
});

describe("scoreQuestion", () => {
  it("subset: expected を全て含めば match(余分な引用は減点しない)", () => {
    const g = golden({
      expected_sources: [{ kind: "github_file", repo: "org/m", path: "a.md" }],
    });
    const a = ans({
      citations: [
        { kind: "github_file", repo: "org/m", path: "a.md" },
        { kind: "github_file", repo: "org/m", path: "extra.md" },
      ],
    });
    expect(scoreQuestion(g, a).matched).toBe(true);
  });

  it("expected の一部が欠けたら不一致", () => {
    const g = golden({
      expected_sources: [
        { kind: "github_file", repo: "org/m", path: "a.md" },
        { kind: "github_file", repo: "org/m", path: "b.md" },
      ],
    });
    const a = ans({ citations: [{ kind: "github_file", repo: "org/m", path: "a.md" }] });
    expect(scoreQuestion(g, a).matched).toBe(false);
  });

  it("NOT_FOUND 期待: notFound:true かつ citations 空で match", () => {
    const g = golden({ not_found: true });
    expect(scoreQuestion(g, ans({ notFound: true, citations: [] })).matched).toBe(true);
    expect(scoreQuestion(g, ans({ notFound: false })).matched).toBe(false);
    // 捏造(notFound だが引用あり)は不一致
    expect(
      scoreQuestion(g, ans({ notFound: true, citations: [{ kind: "discord", url: "x" }] })).matched,
    ).toBe(false);
  });

  it("回答が notFound のとき通常問題は不一致", () => {
    const g = golden({ expected_sources: [{ kind: "github_file", repo: "org/m", path: "a.md" }] });
    expect(scoreQuestion(g, ans({ notFound: true })).matched).toBe(false);
  });
});

describe("scoreRun", () => {
  it("passCount / citationMatchRate を集計(8/10 判定の基盤)", () => {
    const gs: GoldenQa[] = Array.from({ length: 10 }, (_, i) =>
      golden({
        id: `g${i}`,
        expected_sources: [{ kind: "github_file", repo: "org/m", path: `${i}.md` }],
      }),
    );
    // 9 件正解 + 1 件不一致
    const results = gs.map((g, i) => ({
      id: g.id,
      answer: ans({
        citations: i === 9 ? [] : [{ kind: "github_file", repo: "org/m", path: `${i}.md` }],
      }),
    }));
    const score = scoreRun(gs, results);
    expect(score.passCount).toBe(9);
    expect(score.total).toBe(10);
    expect(score.citationMatchRate).toBeCloseTo(0.9);
  });

  it("result が欠落した問題は不一致として数える", () => {
    const gs = [golden({ id: "g0", expected_sources: [] }), golden({ id: "g1", not_found: true })];
    const score = scoreRun(gs, [{ id: "g0", answer: ans({ notFound: false }) }]);
    // g0: expected 空 → every が真 → match。g1: result 欠落 → 不一致。
    expect(score.passCount).toBe(1);
    expect(score.perQuestion.find((q) => q.id === "g1")?.matched).toBe(false);
  });
});
