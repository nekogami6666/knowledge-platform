import { describe, expect, it } from "vitest";
import { type ConfigReader, loadGapConfig } from "./config.js";

const reader = (files: Record<string, string>): ConfigReader => ({
  read: async (n) => files[n] ?? null,
});

const valid = `kb_repo: org/knowledge-base
kb_dir: knowledge-base
assignees:
  - github: yamada
    discord: "901"
`;

describe("loadGapConfig", () => {
  it("gap.yaml を読み base_branch は既定 main・assignees を持つ", async () => {
    const c = await loadGapConfig(reader({ "gap.yaml": valid }));
    expect(c.kb_repo).toBe("org/knowledge-base");
    expect(c.base_branch).toBe("main");
    expect(c.assignees[0]).toEqual({ github: "yamada", discord: "901" });
  });
  it("gap.yaml が無ければ throw", async () => {
    await expect(loadGapConfig(reader({}))).rejects.toThrow();
  });
  it("不明キーは strict で拒否", async () => {
    await expect(loadGapConfig(reader({ "gap.yaml": `${valid}extra: 1\n` }))).rejects.toThrow();
  });
});
