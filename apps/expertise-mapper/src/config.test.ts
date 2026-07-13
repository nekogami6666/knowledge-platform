import { describe, expect, it } from "vitest";
import {
  type ConfigReader,
  expertiseMapperConfigSchema,
  loadExpertiseMapperConfig,
} from "./config.js";
import { isReal, parseEnv, parsePositiveInt } from "./env.js";

const reader = (text: string | null): ConfigReader => ({ read: async () => text });

describe("expertiseMapperConfig", () => {
  it("最小構成(kb.repo のみ)で既定値が入る", async () => {
    const c = await loadExpertiseMapperConfig(reader("kb:\n  repo: org/kb\n"));
    expect(c).toEqual({
      targets: [],
      kb: { repo: "org/kb" },
      base_branch: "main",
      window_days: 90,
    });
  });

  it("targets 空でも valid(commit コレクタのみスキップ — pr-miner と違い機能 OFF にしない)", () => {
    const c = expertiseMapperConfigSchema.parse({ targets: [], kb: { repo: "o/kb" } });
    expect(c.targets).toEqual([]);
  });

  it("ファイル不在は fail-loud", async () => {
    await expect(loadExpertiseMapperConfig(reader(null))).rejects.toThrow(/expertise-mapper.yaml/);
  });

  it("未知キーは strict で拒否", () => {
    expect(() =>
      expertiseMapperConfigSchema.parse({ kb: { repo: "o/kb" }, minutes: {} }),
    ).toThrow();
  });
});

const baseEnv = {
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  ANTHROPIC_AWS_API_KEY: "k",
  ANTHROPIC_AWS_WORKSPACE_ID: "w",
  AWS_REGION: "ap-northeast-1",
  KB_ROOT: "/kb",
};

describe("parseEnv", () => {
  it("必須が揃えば通る(既定は dry-run)", () => {
    const env = parseEnv(baseEnv);
    expect(env.KB_ROOT).toBe("/kb");
    expect(isReal(env)).toBe(false);
  });

  it("EXPERTISE_REAL=1/true で実 commit", () => {
    expect(isReal(parseEnv({ ...baseEnv, EXPERTISE_REAL: "1" }))).toBe(true);
    expect(isReal(parseEnv({ ...baseEnv, EXPERTISE_REAL: "true" }))).toBe(true);
  });

  it("GITHUB_READ_TOKEN は任意(read=PAT / write=App 分離用)", () => {
    expect(parseEnv(baseEnv).GITHUB_READ_TOKEN).toBeUndefined();
    expect(parseEnv({ ...baseEnv, GITHUB_READ_TOKEN: "ghp_x" }).GITHUB_READ_TOKEN).toBe("ghp_x");
  });

  it("parsePositiveInt: 未設定は既定・不正は既定 + warning", () => {
    expect(parsePositiveInt(undefined, 5)).toEqual({ value: 5 });
    expect(parsePositiveInt("7", 5)).toEqual({ value: 7 });
    expect(parsePositiveInt("-1", 5).warning).toBeDefined();
  });
});
