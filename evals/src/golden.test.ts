import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { goldenQaFileSchema, loadGoldenQa } from "./golden.js";

const goldenYaml = readFileSync(
  fileURLToPath(new URL("../golden-qa.yaml", import.meta.url)),
  "utf8",
);

describe("loadGoldenQa", () => {
  it("golden-qa.yaml を読み 10 件を zod で検証して返す", () => {
    const golden = loadGoldenQa(goldenYaml);
    expect(golden).toHaveLength(10);
    expect(golden.map((g) => g.id)).toContain("gq-001");
  });

  it("NOT_FOUND ケース(gq-010)は not_found:true / expected_sources:[]", () => {
    const golden = loadGoldenQa(goldenYaml);
    const g = golden.find((x) => x.id === "gq-010");
    expect(g?.not_found).toBe(true);
    expect(g?.expected_sources).toEqual([]);
  });

  it("expected_sources は QaCitation 形(github_file / discord)で parse される", () => {
    const golden = loadGoldenQa(goldenYaml);
    const file = golden.find((x) => x.id === "gq-001")?.expected_sources[0];
    expect(file).toMatchObject({ kind: "github_file", repo: "org/minutes" });
    const discord = golden.find((x) => x.id === "gq-008")?.expected_sources[0];
    expect(discord).toMatchObject({ kind: "discord" });
  });

  it("not_found 既定は false、answer_points 既定は []", () => {
    const parsed = goldenQaFileSchema.parse([{ id: "x", question: "q", expected_sources: [] }]);
    expect(parsed[0]?.not_found).toBe(false);
    expect(parsed[0]?.answer_points).toEqual([]);
  });

  it("未知キーや不正な citation は reject(strict)", () => {
    expect(() =>
      goldenQaFileSchema.parse([{ id: "x", question: "q", expected_sources: [], bogus: 1 }]),
    ).toThrow();
    expect(() =>
      goldenQaFileSchema.parse([
        { id: "x", question: "q", expected_sources: [{ kind: "github_file", repo: "r" }] },
      ]),
    ).toThrow(); // path 欠落
  });
});
