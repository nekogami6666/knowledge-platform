import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

const VALID_KB = fileURLToPath(new URL("../fixtures/valid-kb", import.meta.url));
const INVALID_KB = fileURLToPath(new URL("../fixtures/invalid-kb", import.meta.url));

describe("runCli", () => {
  it("正常な repo は exit 0", async () => {
    const result = await runCli([VALID_KB]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("OK");
  });

  it("不正な repo は exit 1 で問題を列挙する", async () => {
    const result = await runCli([INVALID_KB]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("NG");
  });

  it("--json は RepoValidationReport としてパース可能", async () => {
    const result = await runCli([INVALID_KB, "--json"]);
    const report = JSON.parse(result.out);
    expect(report.ok).toBe(false);
    expect(Array.isArray(report.problems)).toBe(true);
  });

  it("repo-root 省略は exit 2 で usage", async () => {
    const result = await runCli(["--json"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage");
  });
});
