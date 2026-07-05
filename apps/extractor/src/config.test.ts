import { describe, expect, it } from "vitest";
import { type ConfigReader, loadExtractorConfig } from "./config.js";

const reader = (files: Record<string, string>): ConfigReader => ({
  read: async (n) => files[n] ?? null,
});

const validYaml = `minutes:
  repo: org/minutes
  dir: minutes
kb:
  repo: org/knowledge-base
  dir: knowledge-base
`;

describe("loadExtractorConfig", () => {
  it("extractor.yaml を読み込み base_branch は既定 main", async () => {
    const cfg = await loadExtractorConfig(reader({ "extractor.yaml": validYaml }));
    expect(cfg.minutes.repo).toBe("org/minutes");
    expect(cfg.kb.dir).toBe("knowledge-base");
    expect(cfg.base_branch).toBe("main");
  });
  it("minutes.exclude は既定 transcript.md、明示指定で上書きできる", async () => {
    const def = await loadExtractorConfig(reader({ "extractor.yaml": validYaml }));
    expect(def.minutes.exclude).toEqual(["transcript.md"]);
    const overridden = `minutes:
  repo: org/minutes
  dir: minutes
  exclude: [transcript.md, notes.md]
kb:
  repo: org/knowledge-base
  dir: knowledge-base
`;
    const cfg = await loadExtractorConfig(reader({ "extractor.yaml": overridden }));
    expect(cfg.minutes.exclude).toEqual(["transcript.md", "notes.md"]);
  });
  it("extractor.yaml が無ければ throw", async () => {
    await expect(loadExtractorConfig(reader({}))).rejects.toThrow();
  });
  it("不明キーは strict で拒否", async () => {
    const bad = `${validYaml}extra: 1\n`;
    await expect(loadExtractorConfig(reader({ "extractor.yaml": bad }))).rejects.toThrow();
  });
});
