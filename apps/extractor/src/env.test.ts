import { describe, expect, it } from "vitest";
import { isRealPr, parseEnv, parsePositiveInt } from "./env.js";

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

describe("parsePositiveInt", () => {
  it("正の整数はそのまま採用(warning なし)", () => {
    expect(parsePositiveInt("120000", 300_000)).toEqual({ value: 120_000 });
  });
  it("未設定/空は既定値(warning なし=通常運用)", () => {
    expect(parsePositiveInt(undefined, 300_000)).toEqual({ value: 300_000 });
    expect(parsePositiveInt("   ", 300_000)).toEqual({ value: 300_000 });
  });
  it("NaN・非整数・0・負値は既定にフォールバックし warning を返す", () => {
    for (const bad of ["abc", "12.5", "0", "-5"]) {
      const r = parsePositiveInt(bad, 300_000);
      expect(r.value).toBe(300_000);
      expect(r.warning).toContain(bad);
    }
  });
});
