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

  it("ANTHROPIC_API_KEY が無ければ throw", () => {
    expect(() => parseEnv({ DISCORD_TOKEN: "t" })).toThrow();
  });

  it("既定値は上書きできる", () => {
    const env = parseEnv({ ...base, CLONES_DIR: "/x", CONFIG_DIR: "/c" });
    expect(env.CLONES_DIR).toBe("/x");
    expect(env.CONFIG_DIR).toBe("/c");
  });
});
