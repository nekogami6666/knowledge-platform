import type { PrSummary } from "@stratum/gh-client";
import { describe, expect, it } from "vitest";
import { buildPrTitle, buildRunKey, extractRunKey, findExistingPr } from "./pr-title.js";

const KEY = buildRunKey("abcdef1234567", "0123456aaa");

describe("pr-title", () => {
  it("buildRunKey は minutes/kb 両 head の短縮 SHA を含む(PR-I1)", () => {
    expect(KEY).toBe("abcdef1+0123456");
    expect(buildPrTitle(KEY)).toContain(KEY);
  });
  it("extractRunKey はランキーを取り出す(非該当は null)", () => {
    expect(extractRunKey(buildPrTitle(KEY))).toBe(KEY);
    expect(extractRunKey("無関係なタイトル")).toBeNull();
    expect(extractRunKey("extract: minutes init..abcdef1 ナレッジ抽出")).toBeNull(); // 旧形式
  });
  it("findExistingPr は同一ランキーの open PR を返す(冪等)", () => {
    const prs: PrSummary[] = [
      {
        number: 1,
        title: buildPrTitle(KEY),
        headRef: `extract/${KEY}`,
        url: "https://pr/1",
      },
    ];
    expect(findExistingPr(prs, KEY)?.number).toBe(1);
    expect(findExistingPr(prs, buildRunKey("9999999000", "0123456aaa"))).toBeUndefined();
  });
});
