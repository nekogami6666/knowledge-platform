import { describe, expect, it } from "vitest";
import { citedKindOf, outsideGitWorktree, toLabelRows } from "./export-labels.js";

describe("toLabelRows(較正用ラベル・ADR-0041 D7)", () => {
  it("引用を KB / 議事録 / コード / Discord に分け、読めない行・引用の無い行は捨てる", () => {
    const rows = toLabelRows([
      {
        question: "Q1",
        createdAt: "2026-10-01T10:00:00+09:00",
        systemOneMode: "shadow",
        sourcesJson: JSON.stringify([
          { kind: "github_file", repo: "org/kb", path: "knowledge/hw/kb-1.md", ref: "sha" },
          { kind: "github_file", repo: "org/m", path: "meetings/2026/x/minutes.md", ref: "sha" },
          { kind: "github_file", repo: "org/fw", path: "src/main.c", ref: "sha" },
          { kind: "github_pr", repo: "org/fw", number: 3 },
          { kind: "discord", url: "https://discord.com/channels/1/2/3" },
        ]),
      },
      { question: "Q2", createdAt: "t", systemOneMode: null, sourcesJson: "{broken" },
      { question: "Q3", createdAt: "t", systemOneMode: null, sourcesJson: "[]" },
      { question: "Q4", createdAt: "t", systemOneMode: null, sourcesJson: null },
    ]);
    expect(rows).toEqual([
      {
        question: "Q1",
        createdAt: "2026-10-01T10:00:00+09:00",
        systemOneMode: "shadow",
        citedKinds: ["kb", "minutes", "code", "code", "discord"],
        citedPaths: [
          { kind: "github_file", repo: "org/kb", path: "knowledge/hw/kb-1.md" },
          { kind: "github_file", repo: "org/m", path: "meetings/2026/x/minutes.md" },
          { kind: "github_file", repo: "org/fw", path: "src/main.c" },
          { kind: "github_pr", repo: "org/fw" },
          { kind: "discord", url: "https://discord.com/channels/1/2/3" },
        ],
      },
    ]);
  });

  it("citedKindOf: 未知の種別は null", () => {
    expect(citedKindOf({ kind: "web" })).toBeNull();
    expect(citedKindOf({ kind: "github_file" })).toBeNull();
  });
});

describe("outsideGitWorktree(質問文を含む出力をリポジトリに置かない)", () => {
  it("親のどこかに .git があれば拒否、無ければ null", () => {
    const repo = (p: string) => p === "/home/u/knowledge-platform/.git";
    expect(outsideGitWorktree("/home/u/knowledge-platform/evals/x.jsonl", repo)).toContain(
      "作業ツリーの中",
    );
    expect(outsideGitWorktree("/home/u/labels/x.jsonl", repo)).toBeNull();
  });
});
