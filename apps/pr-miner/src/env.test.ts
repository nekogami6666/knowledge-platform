import { describe, expect, it } from "vitest";
import { isRealPr, parseEnv, parsePositiveInt } from "./env.js";

const base = {
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  ANTHROPIC_AWS_API_KEY: "k",
  ANTHROPIC_AWS_WORKSPACE_ID: "w",
  AWS_REGION: "ap-northeast-1",
  KB_ROOT: "/kb",
};

describe("parseEnv", () => {
  it("必須が揃えば通る(既定は dry-run)", () => {
    const env = parseEnv(base);
    expect(env.KB_ROOT).toBe("/kb");
    expect(isRealPr(env)).toBe(false);
  });

  it("KB_ROOT 欠落は失敗", () => {
    const { KB_ROOT: _drop, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow();
  });

  it("CLAUDE_CODE_USE_ANTHROPIC_AWS が 1/true 以外は失敗(ADR-0009)", () => {
    expect(() => parseEnv({ ...base, CLAUDE_CODE_USE_ANTHROPIC_AWS: "0" })).toThrow();
  });

  it("PR_MINER_REAL=1/true で実 PR", () => {
    expect(isRealPr(parseEnv({ ...base, PR_MINER_REAL: "1" }))).toBe(true);
    expect(isRealPr(parseEnv({ ...base, PR_MINER_REAL: "true" }))).toBe(true);
  });

  it("GITHUB_READ_TOKEN は任意(read=PAT / write=App 分離用・未設定でも通る)", () => {
    expect(parseEnv(base).GITHUB_READ_TOKEN).toBeUndefined();
    expect(parseEnv({ ...base, GITHUB_READ_TOKEN: "ghp_x" }).GITHUB_READ_TOKEN).toBe("ghp_x");
  });
});

describe("parsePositiveInt", () => {
  it("未設定/空は既定・不正値は既定+warning", () => {
    expect(parsePositiveInt(undefined, 4)).toEqual({ value: 4 });
    expect(parsePositiveInt("8", 4)).toEqual({ value: 8 });
    expect(parsePositiveInt("0", 4).value).toBe(4);
    expect(parsePositiveInt("x", 4).warning).toBeDefined();
  });
});
