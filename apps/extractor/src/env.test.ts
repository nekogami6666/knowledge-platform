import { describe, expect, it } from "vitest";
import { isRealPr, parseEnv } from "./env.js";

const base = {
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  ANTHROPIC_AWS_API_KEY: "AEAA-x",
  ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_x",
  AWS_REGION: "ap-northeast-1",
};

describe("parseEnv", () => {
  it("Claude on AWS 必須が揃えば通り既定値が入る", () => {
    const env = parseEnv(base);
    expect(env.CLONES_DIR).toBe("./.clones");
    expect(env.CONFIG_DIR).toBe("./config");
    expect(env.PROMPTS_DIR).toBe("./prompts");
  });
  it("ANTHROPIC_AWS_API_KEY 欠落は throw", () => {
    expect(() => parseEnv({ ...base, ANTHROPIC_AWS_API_KEY: undefined })).toThrow();
  });
  it('CLAUDE_CODE_USE_ANTHROPIC_AWS が "1"/"true" でなければ throw', () => {
    expect(() => parseEnv({ ...base, CLAUDE_CODE_USE_ANTHROPIC_AWS: "0" })).toThrow();
  });
});

describe("isRealPr", () => {
  it("EXTRACTOR_REAL_PR=1/true で true、既定 false", () => {
    expect(isRealPr(parseEnv({ ...base, EXTRACTOR_REAL_PR: "1" }))).toBe(true);
    expect(isRealPr(parseEnv({ ...base, EXTRACTOR_REAL_PR: "true" }))).toBe(true);
    expect(isRealPr(parseEnv(base))).toBe(false);
  });
});
