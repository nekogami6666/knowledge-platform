import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { corpusKbSources } from "./run-qa.js";

const CORPUS = fileURLToPath(new URL("../fixtures/qa-corpus", import.meta.url));
const REPOS = [
  { repo: "org/minutes", dir: "minutes" },
  { repo: "org/knowledge-base", dir: "knowledge-base" },
];

describe("corpusKbSources(qa-corpus の KB 記事の sources を kb-core で読む)", () => {
  const of = corpusKbSources(CORPUS, REPOS);
  it("KB 記事なら sources のファイル参照を返す(Discord の URL は含めない)", () => {
    expect(
      of("org/knowledge-base", "knowledge/hardware/kb-2026-0142-dispenser-x-humidity.md"),
    ).toEqual([{ repo: "org/minutes", path: "2026/06/2026-06-03-hw-weekly.md" }]);
  });
  it("KB 以外・存在しない・未知のリポは []", () => {
    expect(of("org/minutes", "2026/06/2026-06-03-hw-weekly.md")).toEqual([]);
    expect(of("org/knowledge-base", "knowledge/none.md")).toEqual([]);
    expect(of("org/unknown", "knowledge/x.md")).toEqual([]);
  });
});
