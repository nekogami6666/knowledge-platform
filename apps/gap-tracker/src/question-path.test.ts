import { describe, expect, it } from "vitest";
import { matchOpenQuestionBasename } from "./question-path.js";

describe("matchOpenQuestionBasename", () => {
  it("gap-tracker 起票の <id>.md を完全一致で見つける", () => {
    const names = ["q-2026-0007.md", "q-2026-abc123-humidity.md"];
    expect(matchOpenQuestionBasename(names, "q-2026-0007")).toBe("q-2026-0007.md");
  });

  it("extractor 起票の <id>-<slug>.md をプレフィックスで見つける(ADR-0027 D3)", () => {
    const names = ["q-2026-0007.md", "q-2026-abc123-humidity.md"];
    expect(matchOpenQuestionBasename(names, "q-2026-abc123")).toBe("q-2026-abc123-humidity.md");
  });

  it("別 ID に誤一致しない(suffix 固定長 + slug 区切りの -)", () => {
    // "q-2026-0001" を探すとき "q-2026-0001ab-x.md"(6文字乱数 ID)に食い込まない。
    const names = ["q-2026-0001ab-x.md"];
    expect(matchOpenQuestionBasename(names, "q-2026-0001")).toBeUndefined();
  });

  it("見つからなければ undefined", () => {
    expect(matchOpenQuestionBasename([], "q-2026-0007")).toBeUndefined();
  });
});
