import type { PrSummary } from "@stratum/gh-client";
import { describe, expect, it } from "vitest";
import { buildBranch, buildPrTitle, buildRunKey, findOpenExtractPr } from "./pr-title.js";

const KEY = buildRunKey("abcdef1234567", "0123456aaa");

function pr(overrides: Partial<PrSummary>): PrSummary {
  return {
    number: 1,
    title: buildPrTitle(KEY),
    headRef: buildBranch(KEY),
    url: "https://pr/1",
    ...overrides,
  };
}

describe("pr-title", () => {
  it("buildRunKey は minutes/kb 両 head の短縮 SHA を含む(PR-I1)", () => {
    expect(KEY).toBe("abcdef1+0123456");
    expect(buildPrTitle(KEY)).toContain(KEY);
    expect(buildBranch(KEY)).toBe(`extract/${KEY}`);
  });

  it("findOpenExtractPr は extract/ ブランチの PR を返す", () => {
    expect(findOpenExtractPr([pr({})])?.number).toBe(1);
  });

  it("範囲(ランキー)が違っても抽出 PR なら検出する", () => {
    // 上流に新コミットが入るとランキーは変わるが、未マージである以上は見送りたい。
    const other = pr({ number: 2, headRef: buildBranch(buildRunKey("9999999000", "0123456aaa")) });
    expect(findOpenExtractPr([other])?.number).toBe(2);
  });

  it("タイトルが編集されていてもブランチ名で検出する", () => {
    expect(findOpenExtractPr([pr({ title: "人が書き換えたタイトル" })])?.number).toBe(1);
  });

  it("抽出 PR 以外は無視する", () => {
    const others: PrSummary[] = [
      pr({ number: 3, headRef: "pr-miner/2026-W30" }),
      pr({ number: 4, headRef: "feat/something" }),
    ];
    expect(findOpenExtractPr(others)).toBeUndefined();
    expect(findOpenExtractPr([])).toBeUndefined();
  });
});
