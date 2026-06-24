import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const base = { DISCORD_TOKEN: "t", ANTHROPIC_API_KEY: "k" };

describe("parseEnv", () => {
  it("必須が揃えば通り、既定値が入る", () => {
    const env = parseEnv(base);
    expect(env.DISCORD_TOKEN).toBe("t");
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect(env.CLONES_DIR).toBe("./.clones");
    expect(env.DB_PATH).toBe("./data/bot.db");
    expect(env.CONFIG_DIR).toBe("./config");
  });

  it("DISCORD_TOKEN が無ければ throw", () => {
    expect(() => parseEnv({ ANTHROPIC_API_KEY: "k" })).toThrow();
  });

  it("ANTHROPIC_API_KEY が無ければ throw(第一者 API)", () => {
    expect(() => parseEnv({ DISCORD_TOKEN: "t" })).toThrow();
  });

  it("Claude Platform on AWS(CLAUDE_CODE_USE_ANTHROPIC_AWS=1)では ANTHROPIC_API_KEY 無しでも通る(ADR-0008)", () => {
    const env = parseEnv({
      DISCORD_TOKEN: "t",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      ANTHROPIC_AWS_API_KEY: "AEAA-xxx",
      ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_xxx",
      AWS_REGION: "ap-northeast-1",
    });
    expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBe("1");
    expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_xxx");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("既定値は上書きできる", () => {
    const env = parseEnv({ ...base, CLONES_DIR: "/x", CONFIG_DIR: "/c" });
    expect(env.CLONES_DIR).toBe("/x");
    expect(env.CONFIG_DIR).toBe("/c");
  });
});
