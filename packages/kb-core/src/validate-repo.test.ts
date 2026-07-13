import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type RepoProblem, validateRepo } from "./validate-repo.js";

const VALID_KB = fileURLToPath(new URL("../fixtures/valid-kb", import.meta.url));
const INVALID_KB = fileURLToPath(new URL("../fixtures/invalid-kb", import.meta.url));

/** problems から、指定ファイル(部分一致)に紐づく issue code を集める。 */
function codesFor(problems: RepoProblem[], fileSubstr: string): string[] {
  return problems
    .filter((p) => p.file.includes(fileSubstr))
    .flatMap((p) => p.issues.map((i) => i.code));
}

describe("validateRepo", () => {
  it("正常な knowledge-base は ok:true", async () => {
    const report = await validateRepo(VALID_KB);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    // knowledge 2 + decision 1 + question 2 + expertise 1 + members 1
    expect(report.checkedFiles).toBe(7);
  });

  it("_meta/members.yaml が無くても許容(§14#8 未決の間は空・ADR-0017 D3)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "kb-core-members-"));
    try {
      await cp(VALID_KB, tmp, { recursive: true });
      await rm(join(tmp, "_meta", "members.yaml"));
      const report = await validateRepo(tmp);
      expect(report.ok).toBe(true);
      expect(report.checkedFiles).toBe(6); // members 分だけ減る
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("_meta/members.yaml のスキーマ違反(未知フィールド・discord 欠落)を検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    const problem = report.problems.find((p) => p.file.includes("members.yaml"));
    expect(problem).toBeDefined();
    expect(problem?.issues.length).toBeGreaterThan(0);
  });

  it("不正な knowledge-base は ok:false で全件報告する", async () => {
    const report = await validateRepo(INVALID_KB);
    expect(report.ok).toBe(false);
    // 複数ファイルにエラーがあり、途中で止まらない
    const files = new Set(report.problems.map((p) => p.file));
    expect(files.size).toBeGreaterThanOrEqual(6);
  });

  it("sources 空配列(スキーマ違反)を該当ファイル・フィールドで報告する", async () => {
    const report = await validateRepo(INVALID_KB);
    const problem = report.problems.find((p) => p.file.includes("kb-2026-0200-missing-sources"));
    expect(problem).toBeDefined();
    expect(problem!.issues.some((i) => i.path === "sources")).toBe(true);
  });

  it("domain とディレクトリ名の不一致を検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    expect(codesFor(report.problems, "kb-2026-0201-bad-domain")).toContain("domain_mismatch");
  });

  it("ファイル名 ID と frontmatter id の不一致を検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    expect(codesFor(report.problems, "kb-2026-9999-name-mismatch")).toContain(
      "filename_id_mismatch",
    );
  });

  it("knowledge/ 配下の type:decision を検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    expect(codesFor(report.problems, "kb-2026-0203-decision-here")).toContain(
      "decision_in_knowledge",
    );
  });

  it("ID 重複を両ファイルで検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    const dupProblems = report.problems.filter((p) =>
      p.issues.some((i) => i.code === "duplicate_id"),
    );
    expect(dupProblems.length).toBe(2);
  });

  it("questions の status とディレクトリの不整合を検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    expect(codesFor(report.problems, "q-2026-0400-wrong-dir")).toContain("question_dir_mismatch");
  });

  it("expertise.yaml のスキーマ違反を検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    const problem = report.problems.find((p) => p.file.includes("expertise.yaml"));
    expect(problem).toBeDefined();
    expect(problem?.issues.some((i) => i.path.includes("evidence_count"))).toBe(true);
  });

  it("想定外の配置(迷子ファイル)を検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    expect(codesFor(report.problems, "knowledge/kb-2026-0260-stray")).toContain("stray_file");
    expect(codesFor(report.problems, "questions/draft/q-2026-0401-stray")).toContain("stray_file");
    // open/ の下のネストも stray
    expect(codesFor(report.problems, "questions/open/nested/q-2026-0402-nested")).toContain(
      "stray_file",
    );
  });

  it("ファイル名が ID で始まらないものを検出する", async () => {
    const report = await validateRepo(INVALID_KB);
    expect(codesFor(report.problems, "no-id-prefix-name")).toContain("filename_id_mismatch");
  });

  it("存在しない repoRoot は fail-closed(ok:false, repo_not_found)", async () => {
    const report = await validateRepo("/tmp/kb-core-does-not-exist-xyz");
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.issues[0]?.code).toBe("repo_not_found");
  });

  it("knowledge-base に見えないディレクトリは not_a_kb", async () => {
    const dir = fileURLToPath(new URL("../fixtures", import.meta.url)); // KB レイアウトを持たない
    const report = await validateRepo(dir);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.issues.some((i) => i.code === "not_a_kb"))).toBe(true);
  });
});
