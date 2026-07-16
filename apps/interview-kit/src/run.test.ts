import type { GhClient, PrSummary } from "@stratum/gh-client";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import type { QuestionKit } from "./questions.js";
import { type RunDeps, runInterviewKit } from "./run.js";

const KIT: QuestionKit = {
  intro: "狙い。",
  questions: [
    { question: "q1", aim: "a1" },
    { question: "q2", aim: "a2" },
    { question: "q3", aim: "a3" },
    { question: "q4", aim: "a4" },
    { question: "q5", aim: "a5" },
  ],
};

function makeGh(over: Partial<GhClient> = {}): GhClient {
  const fail = (): never => {
    throw new Error("unexpected gh call");
  };
  return {
    createPullRequest: vi.fn(async () => ({ number: 9, url: "https://pr/9" })),
    listPullRequests: vi.fn(async () => [] as PrSummary[]),
    mergePullRequest: async () => fail(),
    getPullRequest: async () => fail(),
    commitFiles: async () => fail(),
    getFileContents: async () => fail(),
    listMergedPullRequests: async () => fail(),
    listPullRequestComments: async () => fail(),
    listPullRequestFiles: async () => fail(),
    listCommits: async () => fail(),
    ...over,
  };
}

function makeDeps(over: Partial<RunDeps> = {}): RunDeps & { ops: string[] } {
  const ops: string[] = [];
  return {
    kbRepo: "org/knowledge-base",
    baseBranch: "main",
    person: "yamada",
    topic: "thermal chamber",
    generate: vi.fn(async () => KIT),
    gh: makeGh(),
    postOps: async (c) => {
      ops.push(c);
    },
    now: () => new Date("2026-07-16T00:00:00Z"),
    logger: createLogger([], () => {}),
    real: true,
    ops,
    ...over,
  };
}

describe("runInterviewKit(§6.6 ⑤-b)", () => {
  it("real: 質問キットの PR を作成して ops へ通知する", async () => {
    const deps = makeDeps({});
    const r = await runInterviewKit(deps);
    expect(r).toMatchObject({
      created: true,
      prUrl: "https://pr/9",
      path: "interviews/kits/yamada-thermal-chamber.md",
    });
    const arg = vi.mocked(deps.gh.createPullRequest).mock.calls[0]?.[0];
    expect(arg?.head).toBe("interview-kit/yamada-thermal-chamber");
    expect(arg?.base).toBe("main");
    expect(arg?.files[0]?.path).toBe("interviews/kits/yamada-thermal-chamber.md");
    expect(arg?.files[0]?.content).toContain("1. **q1**");
    expect(deps.ops).toHaveLength(1);
    expect(deps.ops[0]).toContain("https://pr/9");
  });

  it("dry-run: 生成はするが PR も gh も呼ばない(質問リストをログ)", async () => {
    const lines: string[] = [];
    const deps = makeDeps({ real: false, logger: createLogger([], (l) => lines.push(l)) });
    const r = await runInterviewKit(deps);
    expect(r).toMatchObject({ created: false, reason: "dry-run" });
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.gh.createPullRequest).not.toHaveBeenCalled();
    expect(deps.gh.listPullRequests).not.toHaveBeenCalled();
    expect(deps.ops).toHaveLength(0);
    expect(lines.some((l) => l.includes("q1"))).toBe(true);
  });

  it("同一対象の open PR が既存 → LLM を呼ばずに冪等 skip", async () => {
    const existing: PrSummary = {
      number: 7,
      title: "docs(interview): yamada × thermal chamber の質問キット(§6.6 ⑤-b)",
      headRef: "interview-kit/yamada-thermal-chamber",
      url: "https://existing",
    };
    const deps = makeDeps({ gh: makeGh({ listPullRequests: vi.fn(async () => [existing]) }) });
    const r = await runInterviewKit(deps);
    expect(r).toMatchObject({
      created: false,
      reason: "already-exists",
      prUrl: "https://existing",
    });
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.gh.createPullRequest).not.toHaveBeenCalled();
  });
});
