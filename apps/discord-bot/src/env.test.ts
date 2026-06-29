import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

// Claude on AWS の必須 env 一式(ADR-0009)。
const base = {
  DISCORD_TOKEN: "t",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  ANTHROPIC_AWS_API_KEY: "AEAA-xxx",
  ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_xxx",
  AWS_REGION: "ap-northeast-1",
};

describe("parseEnv", () => {
  it("Claude on AWS の必須が揃えば通り、既定値が入る(ADR-0009)", () => {
    const env = parseEnv(base);
    expect(env.DISCORD_TOKEN).toBe("t");
    expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBe("1");
    expect(env.ANTHROPIC_AWS_API_KEY).toBe("AEAA-xxx");
    expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_xxx");
    expect(env.AWS_REGION).toBe("ap-northeast-1");
    expect(env.CLONES_DIR).toBe("./.clones");
    expect(env.DB_PATH).toBe("./data/bot.db");
    expect(env.CONFIG_DIR).toBe("./config");
  });

  it("DISCORD_TOKEN が無ければ throw", () => {
    expect(() => parseEnv({ ...base, DISCORD_TOKEN: undefined })).toThrow();
  });

  it("ANTHROPIC_AWS_API_KEY が無ければ throw(Claude on AWS 必須・ADR-0009)", () => {
    expect(() => parseEnv({ ...base, ANTHROPIC_AWS_API_KEY: undefined })).toThrow();
  });

  it("ANTHROPIC_AWS_WORKSPACE_ID / AWS_REGION が無ければ throw(Claude on AWS 必須)", () => {
    expect(() => parseEnv({ ...base, ANTHROPIC_AWS_WORKSPACE_ID: undefined })).toThrow();
    expect(() => parseEnv({ ...base, AWS_REGION: undefined })).toThrow();
  });

  it('CLAUDE_CODE_USE_ANTHROPIC_AWS が "1"/"true" でなければ throw(ADR-0009)', () => {
    expect(() => parseEnv({ ...base, CLAUDE_CODE_USE_ANTHROPIC_AWS: "0" })).toThrow();
    expect(() => parseEnv({ ...base, CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined })).toThrow();
  });

  it('CLAUDE_CODE_USE_ANTHROPIC_AWS="true" でも通る', () => {
    const env = parseEnv({ ...base, CLAUDE_CODE_USE_ANTHROPIC_AWS: "true" });
    expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBe("true");
  });

  it("既定値は上書きできる", () => {
    const env = parseEnv({ ...base, CLONES_DIR: "/x", CONFIG_DIR: "/c" });
    expect(env.CLONES_DIR).toBe("/x");
    expect(env.CONFIG_DIR).toBe("/c");
  });
});
