import type {
  CommitSummary,
  GhClient,
  MergedPrSummary,
  PrCommentItem,
  PrFileSummary,
  PrSummary,
} from "@stratum/gh-client";
import type { IdCounterFile, IdCounterStore } from "@stratum/kb-core";
import { describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "./candidate.js";
import type { ExtractorConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildPrTitle } from "./pr-title.js";
import { type RunDeps, runExtractor } from "./run.js";
import type { Verdict } from "./verdict.js";

const HEAD = "abcdef1234567890"; // 小文字 hex(pr-title の正規表現に一致)

const config: ExtractorConfig = {
  minutes: { repo: "org/minutes", dir: "minutes", exclude: ["transcript.md"] },
  kb: { repo: "org/knowledge-base", dir: "knowledge-base" },
  base_branch: "main",
};

function memStore(seed: IdCounterFile): IdCounterStore {
  let counters = structuredClone(seed);
  let version = "v0";
  let n = 0;
  return {
    load: async () => ({ counters: structuredClone(counters), version }),
    save: async (c, expected) => {
      if (expected !== version) throw new Error("conflict");
      counters = structuredClone(c);
      n += 1;
      version = `v${n}`;
    },
  };
}

const oneLearning: ExtractionResult = {
  decisions: [],
  learnings: [
    {
      kind: "learning",
      title: "湿度しきい値",
      body: "40%RH 以下",
      entryType: "fact",
      domain: "hardware",
      people: ["yamada"],
      tags: [],
      confidence: "high",
      slug: "humidity",
    },
  ],
  openQuestions: [],
};

function extractionWithDomain(domain: string): ExtractionResult {
  return {
    decisions: [],
    learnings: [
      {
        kind: "learning",
        title: "t",
        body: "b",
        entryType: "fact",
        domain,
        people: ["yamada"],
        tags: [],
        confidence: "high",
        slug: "t",
      },
    ],
    openQuestions: [],
  };
}

function makeGh(over: Partial<GhClient> = {}): GhClient {
  return {
    createPullRequest: vi.fn(async () => ({ number: 99, url: "https://github.com/o/kb/pull/99" })),
    listPullRequests: vi.fn(async (): Promise<PrSummary[]> => []),
    mergePullRequest: vi.fn(async () => {}),
    getPullRequest: vi.fn(async () => {
      throw new Error("not used in extractor tests");
    }),
    commitFiles: vi.fn(async () => {
      throw new Error("not used in extractor tests");
    }),
    getFileContents: vi.fn(async () => null),
    listMergedPullRequests: vi.fn(async (): Promise<MergedPrSummary[]> => []),
    listPullRequestComments: vi.fn(async (): Promise<PrCommentItem[]> => []),
    listPullRequestFiles: vi.fn(async (): Promise<PrFileSummary[]> => []),
    listCommits: vi.fn(async (): Promise<CommitSummary[]> => []),
    ...over,
  };
}

function makeDeps(over: Partial<RunDeps> = {}): RunDeps {
  const files: Record<string, string> = {
    "/kb/_meta/id-counter.json": JSON.stringify({ kb: { "2026": 144 } }),
    "/m/2026/06/x.md": "# 会議\n参加者: yamada\n湿度しきい値を 40%RH 以下に更新。",
  };
  const prompt = { read: async () => "---\nrole: standard\n---\nRULES" };
  return {
    config,
    syncer: {
      sync: async () => ({
        minutes: { repo: "org/minutes", absDir: "/m", resolvedCommit: HEAD },
        kb: { repo: "org/knowledge-base", absDir: "/kb", resolvedCommit: "kbsha" },
      }),
    },
    gh: makeGh(),
    extractDeps: {
      promptStore: prompt,
      search: async () => ({ value: oneLearning, usage: { inputTokens: 1, outputTokens: 1 } }),
    },
    reconcileDeps: {
      promptStore: prompt,
      search: async () => ({
        value: { classification: "new", reason: "新規" } as Verdict,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    },
    makeIdStore: () => memStore({ kb: { "2026": 143 }, dr: { "2026": 31 }, q: { "2026": 88 } }),
    validate: async () => ({ ok: true, problems: [] }),
    readFile: async (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async () => {},
    exec: async () => ({ stdout: "2026/06/x.md\n" }),
    readdir: async () => [],
    notifier: { notifyPrCreated: vi.fn(async () => {}) },
    now: () => new Date("2026-07-01T00:00:00Z"),
    logger: createLogger([], () => {}),
    realPr: true,
    reconcileConcurrency: 4,
    ...over,
  };
}

describe("runExtractor", () => {
  it("happy path: 1 PR を作成(state.json + entry + id-counter を含む)", async () => {
    const gh = makeGh();
    const notifier = { notifyPrCreated: vi.fn(async () => {}) };
    const r = await runExtractor(makeDeps({ gh, notifier }));
    expect(r.created).toBe(true);
    expect(r.prUrl).toBe("https://github.com/o/kb/pull/99");
    expect(gh.createPullRequest).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const paths = arg?.files.map((f) => f.path) ?? [];
    expect(paths).toContain("_meta/state.json");
    expect(paths).toContain("_meta/id-counter.json");
    expect(paths.some((p) => p.startsWith("knowledge/hardware/kb-2026-0144"))).toBe(true);
    expect(arg?.title).toContain("init..abcdef1");
    expect(notifier.notifyPrCreated).toHaveBeenCalledTimes(1);
    expect(r.domains.candidateCount).toBe(1);
    expect(r.domains.newDomains).toContain("hardware");
    expect(r.domains.reusedDomainCount).toBe(0);
  });

  it("既存 domain に載る新規 learning は再利用としてカウント", async () => {
    const r = await runExtractor(
      makeDeps({ readdir: async () => [{ name: "hardware", isDirectory: () => true }] }),
    );
    expect(r.domains.reusedDomainCount).toBe(1);
    expect(r.domains.newDomains).toEqual([]);
  });

  it("新設 domain が既存に近いと nearDuplicates + 警告ログ", async () => {
    const logs: string[] = [];
    const r = await runExtractor(
      makeDeps({
        readdir: async () => [{ name: "hardware", isDirectory: () => true }],
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({
            value: extractionWithDomain("hardware-verification"),
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
        logger: createLogger([], (l) => logs.push(l)),
      }),
    );
    expect(r.domains.nearDuplicates).toEqual([
      { domain: "hardware-verification", near: "hardware" },
    ]);
    expect(logs.some((l) => l.includes("近い"))).toBe(true);
  });

  it("変更なし → PR を作成しない", async () => {
    const gh = makeGh();
    const r = await runExtractor(makeDeps({ gh, exec: async () => ({ stdout: "" }) }));
    expect(r.created).toBe(false);
    expect(r.reason).toBe("no-changes");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
  });

  it("同一 head の PR が既存 → 冪等 skip", async () => {
    const existing: PrSummary = {
      number: 7,
      title: buildPrTitle(null, HEAD),
      headRef: "extract/abcdef1",
      url: "https://existing",
    };
    const gh = makeGh({ listPullRequests: vi.fn(async () => [existing]) });
    const r = await runExtractor(makeDeps({ gh }));
    expect(r.created).toBe(false);
    expect(r.reason).toBe("already-exists");
    expect(r.prUrl).toBe("https://existing");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
  });

  it("validateRepo 失敗 → PR を作成しない", async () => {
    const gh = makeGh();
    const r = await runExtractor(
      makeDeps({ gh, validate: async () => ({ ok: false, problems: [{}] }) }),
    );
    expect(r.created).toBe(false);
    expect(r.reason).toBe("validation-failed");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
  });

  it("dry-run(realPr=false) → PR も gh も呼ばない", async () => {
    const gh = makeGh();
    const r = await runExtractor(makeDeps({ gh, realPr: false }));
    expect(r.created).toBe(false);
    expect(r.reason).toBe("dry-run");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
    expect(gh.listPullRequests).not.toHaveBeenCalled();
  });

  it("reconcile 失敗の候補は skip+記録し、他は materialize して継続(並列・§2-E)", async () => {
    const twoLearnings: ExtractionResult = {
      decisions: [],
      learnings: [
        {
          kind: "learning",
          title: "a",
          body: "b",
          entryType: "fact",
          domain: "hardware",
          people: ["x"],
          tags: [],
          confidence: "high",
          slug: "a",
        },
        {
          kind: "learning",
          title: "c",
          body: "d",
          entryType: "fact",
          domain: "firmware",
          people: ["y"],
          tags: [],
          confidence: "high",
          slug: "c",
        },
      ],
      openQuestions: [],
    };
    const prompt = { read: async () => "---\nrole: standard\n---\nR" };
    const r = await runExtractor(
      makeDeps({
        extractDeps: {
          promptStore: prompt,
          search: async () => ({
            value: twoLearnings,
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
        reconcileDeps: {
          promptStore: prompt,
          search: async (opts) => {
            if (opts.prompt.includes("firmware")) throw new Error("boom");
            return {
              value: { classification: "new", reason: "ok" } as Verdict,
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
      }),
    );
    expect(r.created).toBe(true);
    expect(r.counts.new).toBe(1);
    expect(r.counts.skip).toBe(1);
  });

  it("段階別 timings を計測する(monotonicMs 注入)", async () => {
    let t = 0;
    const r = await runExtractor(makeDeps({ monotonicMs: () => (t += 5) }));
    expect(r.timings).toBeDefined();
    expect(typeof r.timings?.reconcileMs).toBe("number");
    expect(r.timings?.reconcileMs).toBeGreaterThanOrEqual(0);
  });
});
