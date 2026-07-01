import type { PrSummary } from "@stratum/gh-client";
import { describe, expect, it } from "vitest";
import { buildPrTitle, extractHeadSha, findExistingPr } from "./pr-title.js";

describe("pr-title", () => {
  it("buildPrTitle は head 短縮 SHA を含む(初回は init)", () => {
    expect(buildPrTitle(null, "abcdef1234567")).toContain("init..abcdef1");
    expect(buildPrTitle("0000000aaa", "abcdef1234567")).toContain("0000000..abcdef1");
  });
  it("extractHeadSha は head を取り出す(非該当は null)", () => {
    expect(extractHeadSha(buildPrTitle(null, "abcdef1234567"))).toBe("abcdef1");
    expect(extractHeadSha("無関係なタイトル")).toBeNull();
  });
  it("findExistingPr は同一 head の open PR を返す(冪等)", () => {
    const prs: PrSummary[] = [
      {
        number: 1,
        title: buildPrTitle(null, "abcdef1234567"),
        headRef: "extract/abcdef1",
        url: "https://pr/1",
      },
    ];
    expect(findExistingPr(prs, "abcdef1234567")?.number).toBe(1);
    expect(findExistingPr(prs, "9999999000")).toBeUndefined();
  });
});
