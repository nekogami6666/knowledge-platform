import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("英語タイトルを kebab に", () => {
    expect(slugify("Humidity Threshold Update")).toBe("humidity-threshold-update");
  });
  it("日本語のみは entry にフォールバック", () => {
    expect(slugify("湿度しきい値の更新")).toBe("entry");
  });
  it("記号・前後ハイフンを整理", () => {
    expect(slugify("  SWD (direct) !! ")).toBe("swd-direct");
  });
  it("長いタイトルは 40 文字以内に切り詰め", () => {
    expect(slugify("a".repeat(50)).length).toBeLessThanOrEqual(40);
  });
});
