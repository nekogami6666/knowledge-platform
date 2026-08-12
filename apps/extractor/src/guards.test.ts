import { describe, expect, it } from "vitest";
import type { DecisionCandidate, ExtractionResult, LearningCandidate } from "./candidate.js";
import { applyCandidateGuards, hasAmbiguousRange, NEEDS_VERIFICATION_TAG } from "./guards.js";

function decision(over: Partial<DecisionCandidate> = {}): DecisionCandidate {
  return {
    kind: "decision",
    title: "分注ヘッドは SWD を採用する",
    decision: "比較検証の結果、SWD 方式を採用する。",
    deciders: ["nagata"],
    confidence: "high",
    ...over,
  };
}

function learning(over: Partial<LearningCandidate> = {}): LearningCandidate {
  return {
    kind: "learning",
    title: "高湿度で Y 軸が脱調する",
    body: "湿度 60% 超で Y 軸モーターが脱調した。",
    entryType: "learning",
    domain: "hardware",
    people: ["ide"],
    tags: [],
    confidence: "medium",
    ...over,
  };
}

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return { decisions: [], learnings: [], openQuestions: [], ...over };
}

describe("hasAmbiguousRange", () => {
  it("桁の飛ぶレンジ(5〜60万円)を検知する", () => {
    expect(hasAmbiguousRange("費用は 5〜60万円 の見積もり")).toBe(true);
  });

  it("通常の幅(40〜60%)は検知しない", () => {
    expect(hasAmbiguousRange("湿度 40〜60% を維持する")).toBe(false);
  });

  it("全角チルダ・波ダッシュも扱う", () => {
    expect(hasAmbiguousRange("1~15 台")).toBe(true);
    expect(hasAmbiguousRange("3～30 日")).toBe(true);
  });
});

describe("applyCandidateGuards — 不確実性ガード(検証テスト6)", () => {
  it("未確定表現(可能性が高い)を含む decision を open question に降格する", () => {
    const r = applyCandidateGuards(
      extraction({
        decisions: [decision({ decision: "X 方式で解決できる可能性が高いため採用する。" })],
      }),
    );
    expect(r.extraction.decisions).toHaveLength(0);
    expect(r.extraction.openQuestions).toHaveLength(1);
    expect(r.extraction.openQuestions[0]?.title).toBe("分注ヘッドは SWD を採用する");
    expect(r.demotedDecisions).toBe(1);
  });

  it("「検討する」「未確認」「〜の方向で」も降格する", () => {
    const r = applyCandidateGuards(
      extraction({
        decisions: [
          decision({ decision: "次回までに B 案を検討する。" }),
          decision({ decision: "耐久性は未確認だが C 材を使う。" }),
          decision({ decision: "内製の方向で進める。" }),
        ],
      }),
    );
    expect(r.extraction.decisions).toHaveLength(0);
    expect(r.demotedDecisions).toBe(3);
    expect(r.extraction.openQuestions).toHaveLength(3);
  });

  it("降格した open question は元の決定文と lines を保持する(情報を失わない)", () => {
    const r = applyCandidateGuards(
      extraction({
        decisions: [decision({ decision: "たぶん D 社製で足りる。", lines: "L10-L12" })],
      }),
    );
    expect(r.extraction.openQuestions[0]?.body).toContain("たぶん D 社製で足りる。");
    expect(r.extraction.openQuestions[0]?.lines).toBe("L10-L12");
  });

  it("確定した decision はそのまま通す", () => {
    const r = applyCandidateGuards(extraction({ decisions: [decision()] }));
    expect(r.extraction.decisions).toHaveLength(1);
    expect(r.demotedDecisions).toBe(0);
    expect(r.extraction.openQuestions).toHaveLength(0);
  });
});

describe("applyCandidateGuards — 曖昧レンジガード(検証テスト5)", () => {
  it("桁の飛ぶレンジ(5〜60万円)を含む decision は確定エントリにしない", () => {
    const r = applyCandidateGuards(
      extraction({ decisions: [decision({ decision: "改修費は 5〜60万円 で承認する。" })] }),
    );
    expect(r.extraction.decisions).toHaveLength(0);
    expect(r.extraction.openQuestions).toHaveLength(1);
    expect(r.demotedDecisions).toBe(1);
  });

  it("通常の幅(40〜60%)の decision は通す", () => {
    const r = applyCandidateGuards(
      extraction({ decisions: [decision({ decision: "保管湿度は 40〜60% とする。" })] }),
    );
    expect(r.extraction.decisions).toHaveLength(1);
    expect(r.demotedDecisions).toBe(0);
  });
});

describe("applyCandidateGuards — 安全ガード(検証テスト7)", () => {
  it("安全語彙(AC100V)を含む procedure は learning + confidence low + 要確認タグになる", () => {
    const r = applyCandidateGuards(
      extraction({
        learnings: [
          learning({
            title: "分電盤の配線手順",
            body: "AC100V 系統の配線は主幹ブレーカーを落としてから行う。",
            entryType: "procedure",
            confidence: "high",
          }),
        ],
      }),
    );
    const guarded = r.extraction.learnings[0];
    expect(guarded?.entryType).toBe("learning");
    expect(guarded?.confidence).toBe("low");
    expect(guarded?.tags).toContain(NEEDS_VERIFICATION_TAG);
    expect(r.safetyFlagged).toBe(1);
  });

  it("安全語彙を含む learning には確認用 open question を併発する", () => {
    const r = applyCandidateGuards(
      extraction({
        learnings: [learning({ body: "耐圧は 0.5MPa まで確認済みとのこと。", lines: "L5" })],
      }),
    );
    expect(r.extraction.openQuestions).toHaveLength(1);
    expect(r.extraction.openQuestions[0]?.title).toContain("要確認");
    expect(r.extraction.openQuestions[0]?.lines).toBe("L5");
  });

  it("既に要確認タグがある場合は重複追加しない", () => {
    const r = applyCandidateGuards(
      extraction({
        learnings: [learning({ body: "電源系統の注意点。", tags: [NEEDS_VERIFICATION_TAG] })],
      }),
    );
    expect(
      r.extraction.learnings[0]?.tags.filter((t) => t === NEEDS_VERIFICATION_TAG),
    ).toHaveLength(1);
  });

  it("安全語彙を含まない learning は変更しない", () => {
    const input = extraction({ learnings: [learning()] });
    const r = applyCandidateGuards(input);
    expect(r.extraction.learnings[0]).toEqual(input.learnings[0]);
    expect(r.safetyFlagged).toBe(0);
  });
});

describe("applyCandidateGuards — 全体", () => {
  it("既存の openQuestions を保持したまま降格分を追記する", () => {
    const r = applyCandidateGuards(
      extraction({
        decisions: [decision({ decision: "E 案の見込みで進める。" })],
        openQuestions: [{ kind: "open_question", title: "既存の問い", body: "本文" }],
      }),
    );
    expect(r.extraction.openQuestions).toHaveLength(2);
    expect(r.extraction.openQuestions[0]?.title).toBe("既存の問い");
  });

  it("入力の ExtractionResult を変更しない(純関数)", () => {
    const input = extraction({
      decisions: [decision({ decision: "F 案を検討する。" })],
      learnings: [learning({ body: "AC100V の注意点。", entryType: "procedure" })],
    });
    applyCandidateGuards(input);
    expect(input.decisions).toHaveLength(1);
    expect(input.learnings[0]?.entryType).toBe("procedure");
    expect(input.openQuestions).toHaveLength(0);
  });
});
