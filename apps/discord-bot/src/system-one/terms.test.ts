import { describe, expect, it } from "vitest";
import { extractTerms, normalizeText, parseTimeWindow, questionSignals } from "./terms.js";

// 2026-10-08(木)12:00 JST
const NOW = Date.parse("2026-10-08T12:00:00+09:00");

const texts = (q: string, kind?: string): string[] =>
  extractTerms(q)
    .filter((t) => kind === undefined || t.kind === kind)
    .map((t) => t.text);

describe("extractTerms(ADR-0041 D1)", () => {
  it("漢字・カタカナ・英数字の連なりを取り、ひらがな・助詞・定型句を落とす", () => {
    const got = texts("分注ロボット X は高湿度環境で何が起きますか?");
    expect(got).toContain("分注");
    expect(got).toContain("ロボット");
    expect(got).toContain("高湿度環境");
    expect(got).not.toContain("x"); // 1 文字は落とす
    expect(got).not.toContain("何"); // 1 文字 & stopword
    expect(got.some((t) => /[ぁ-ん]/.test(t))).toBe(false);
  });

  it("3 文字以上の漢字の連なりには弱い重みの bigram を足す", () => {
    const terms = extractTerms("推奨湿度しきい値は?");
    const main = terms.find((t) => t.text === "推奨湿度");
    expect(main?.kind).toBe("kanji");
    expect(main?.weight).toBe(1);
    const bi = terms.filter((t) => t.kind === "bigram").map((t) => t.text);
    expect(bi).toEqual(["推奨", "奨湿", "湿度"]);
    expect(terms.find((t) => t.text === "湿度")?.weight).toBeLessThan(0.5);
  });

  it("全角英数・半角カナを正規化し、英字は小文字にする", () => {
    expect(normalizeText("ＳＷＤ ｶﾒﾗ")).toBe("swd カメラ");
    expect(texts("ＳＷＤ 直結とＣＡＮ")).toEqual(expect.arrayContaining(["swd", "直結", "can"]));
  });

  it("絵文字(💡 等)は 1 文字でも語にする(bot の操作名として文書に現れる)", () => {
    const t = extractTerms("💡 を付けたのに何も起きない");
    expect(t.find((x) => x.text === "💡")).toMatchObject({ kind: "symbol", weight: 0.6 });
  });

  it("stopword(最近・内容・状況 等)は語にしない・重複は 1 回", () => {
    expect(texts("最近の内容と状況、状況について教えて")).toEqual([]);
    expect(texts("脱調 脱調 脱調")).toEqual(["脱調"]);
  });

  it("数字だけの語は弱い重み", () => {
    const t = extractTerms("45%RH 以下");
    expect(t.find((x) => x.text === "45")?.weight).toBeLessThan(0.5);
    expect(t.find((x) => x.text === "rh")?.weight).toBe(0.6);
  });
});

describe("parseTimeWindow(JST・今は注入)", () => {
  const w = (q: string) => parseTimeWindow(q, NOW).window;

  it("昨日・一昨日・今日", () => {
    expect(w("昨日の定例で決まったこと")).toMatchObject({
      since: "2026-10-07",
      until: "2026-10-07",
    });
    expect(w("一昨日の話")).toMatchObject({ since: "2026-10-06", until: "2026-10-06" });
    expect(w("今日の予定")).toMatchObject({ since: "2026-10-08", until: "2026-10-08" });
  });

  it("今週・先週(月曜始まり)", () => {
    expect(w("今週の議事録")).toMatchObject({ since: "2026-10-05", until: "2026-10-08" });
    expect(w("先週の議事録")).toMatchObject({ since: "2026-09-28", until: "2026-10-04" });
  });

  it("今月・先月・最近(30 日)", () => {
    expect(w("今月の決定")).toMatchObject({ since: "2026-10-01", until: "2026-10-08" });
    expect(w("先月の決定")).toMatchObject({ since: "2026-09-01", until: "2026-09-30" });
    expect(w("最近の進捗")).toMatchObject({ since: "2026-09-08", until: "2026-10-08" });
  });

  it("N月(未来の月は前年)・N月N日・YYYY-MM-DD・M/D", () => {
    expect(w("9月の定例")).toMatchObject({ since: "2026-09-01", until: "2026-09-30" });
    expect(w("12月の定例")).toMatchObject({ since: "2025-12-01", until: "2025-12-31" });
    expect(w("6月3日のHW定例")).toMatchObject({ since: "2026-06-03", until: "2026-06-03" });
    expect(w("2026-06-10 の議事録")).toMatchObject({ since: "2026-06-10", until: "2026-06-10" });
    expect(w("6/3 の会議")).toMatchObject({ since: "2026-06-03", until: "2026-06-03" });
    expect(w("2025年11月の件")).toMatchObject({ since: "2025-11-01", until: "2025-11-30" });
  });

  it("複数の表現は全体を覆う範囲・時間表現は語から外れる", () => {
    const r = parseTimeWindow("6/3 と 6/10 の HW 定例の違い", NOW);
    expect(r.window).toMatchObject({ since: "2026-06-03", until: "2026-06-10" });
    // 日付の数字は語に残らない(「違い」の「違」は 1 文字なので落ちる)。
    expect(texts(r.stripped)).toEqual(["hw", "定例"]);
  });

  it("時間表現が無ければ null・不正な日付は無視", () => {
    expect(w("分注ロボットの湿度")).toBeNull();
    expect(w("13/45 の比率")).toBeNull();
  });
});

describe("questionSignals", () => {
  it("時間・コード・識別子の手がかり", () => {
    expect(questionSignals("最新の進捗は?").timeWords).toBe(1);
    expect(questionSignals("この関数の実装はどこ?").codeWords).toBe(1);
    expect(questionSignals("runAgentSearch の引数は?").identifierLike).toBe(1);
    expect(questionSignals("config.yaml の場所").identifierLike).toBe(1);
    const none = questionSignals("分注ロボットの湿度対策は?");
    expect(none).toEqual({ timeWords: 0, codeWords: 0, identifierLike: 0 });
  });
});
