import { describe, expect, it } from "vitest";
import { type ConfigReader, loadPrMinerConfig, prMinerConfigSchema } from "./config.js";

function reader(files: Record<string, string>): ConfigReader {
  return { read: async (name) => files[name] ?? null };
}

describe("prMinerConfigSchema", () => {
  it("targets 既定は空(機能 OFF)、base_branch/window_days に既定", () => {
    const c = prMinerConfigSchema.parse({ kb: { repo: "org/kb" } });
    expect(c.targets).toEqual([]);
    expect(c.base_branch).toBe("main");
    expect(c.window_days).toBe(7);
  });

  it("kb.repo は必須", () => {
    expect(() => prMinerConfigSchema.parse({})).toThrow();
  });

  it("未知キーは strict で拒否", () => {
    expect(() => prMinerConfigSchema.parse({ kb: { repo: "o/r" }, nope: 1 })).toThrow();
  });
});

describe("loadPrMinerConfig", () => {
  it("pr-miner.yaml を読む", async () => {
    const c = await loadPrMinerConfig(
      reader({ "pr-miner.yaml": "targets:\n  - org/a\nkb:\n  repo: org/kb\nwindow_days: 14\n" }),
    );
    expect(c.targets).toEqual(["org/a"]);
    expect(c.window_days).toBe(14);
  });

  it("ファイル欠落は明示エラー", async () => {
    await expect(loadPrMinerConfig(reader({}))).rejects.toThrow(/pr-miner\.yaml/);
  });
});
