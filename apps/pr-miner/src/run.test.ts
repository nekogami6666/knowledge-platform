import type { ExtractionResult } from "@stratum/extractor/candidate";
import type { Verdict } from "@stratum/extractor/verdict";
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
import type { PrMinerConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { type RunDeps, runPrMiner } from "./run.js";

const config: PrMinerConfig = {
  targets: ["org/dev"],
  kb: { repo: "org/knowledge-base" },
  base_branch: "main",
  window_days: 7,
};

const NOW = new Date("2026-07-09T00:00:00Z"); // W28

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
      title: "早期打ち切りの健全性",
      body: "merged_at ≤ updated_at",
      entryType: "learning",
      domain: "gh-client",
      people: ["yamada"],
      tags: [],
      confidence: "high",
      slug: "early-exit",
    },
  ],
  openQuestions: [],
};

const oneDecisionNoDeciders: ExtractionResult = {
  decisions: [
    {
      kind: "decision",
      title: "OctokitLike は optional 拡張",
      decision: "既存 fake を壊さないため optional で足す",
      deciders: [], // deciders 空 → author フォールバックを試す
      confidence: "high",
      slug: "octokit-optional",
    },
  ],
  learnings: [],
  openQuestions: [],
};

const newVerdict: Verdict = { classification: "new", reason: "新規" };

function mergedPr(over: Partial<MergedPrSummary> & { number: number }): MergedPrSummary {
  return {
    title: `PR ${over.number}`,
    body: "本文",
    author: "yamada",
    mergedAt: "2026-07-05T00:00:00Z",
    url: `https://github.com/org/dev/pull/${over.number}`,
    ...over,
  };
}

function makeGh(over: Partial<GhClient> = {}): GhClient {
  return {
    createPullRequest: vi.fn(async () => ({ number: 99, url: "https://github.com/o/kb/pull/99" })),
    listPullRequests: vi.fn(async (): Promise<PrSummary[]> => []),
    mergePullRequest: vi.fn(async () => {}),
    getPullRequest: vi.fn(async () => {
      throw new Error("unused");
    }),
    commitFiles: vi.fn(async () => {
      throw new Error("unused");
    }),
    getFileContents: vi.fn(async () => null),
    listMergedPullRequests: vi.fn(
      async (): Promise<MergedPrSummary[]> => [mergedPr({ number: 10 })],
    ),
    listPullRequestComments: vi.fn(async (): Promise<PrCommentItem[]> => []),
    listPullRequestFiles: vi.fn(async (): Promise<PrFileSummary[]> => []),
    listCommits: vi.fn(async (): Promise<CommitSummary[]> => []),
    ...over,
  };
}

function makeDeps(over: Partial<RunDeps> = {}): { deps: RunDeps; written: Record<string, string> } {
  const written: Record<string, string> = {};
  const fsFiles: Record<string, string> = {
    "/kb/_meta/id-counter.json": JSON.stringify({ kb: { "2026": 144 }, dr: { "2026": 30 } }),
  };
  const prompt = { read: async () => "---\nrole: standard\n---\nRULES" };
  const deps: RunDeps = {
    config,
    kbRoot: "/kb",
    gh: makeGh(),
    extractDeps: {
      promptStore: prompt,
      search: async () => ({ value: oneLearning, usage: { inputTokens: 1, outputTokens: 1 } }),
    },
    reconcileDeps: {
      promptStore: prompt,
      search: async () => ({ value: newVerdict, usage: { inputTokens: 1, outputTokens: 1 } }),
    },
    makeIdStore: () => memStore({ kb: { "2026": 144 }, dr: { "2026": 30 } }),
    validate: async () => ({ ok: true, problems: [] }),
    readFile: async (p) => {
      const v = fsFiles[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, content) => {
      written[p] = content;
    },
    readdir: async () => [],
    notifier: { notifyPrCreated: vi.fn(async () => {}) },
    now: () => NOW,
    logger: createLogger([], () => {}),
    realPr: true,
    reconcileConcurrency: 4,
    ...over,
  };
  return { deps, written };
}

describe("runPrMiner", () => {
  it("ghRead 指定時: 対象リポの読み取りは ghRead、KB 操作(open 検知・PR 作成)は gh を使う", async () => {
    const gh = makeGh();
    const ghRead = makeGh();
    const { deps } = makeDeps({ gh, ghRead });
    const summary = await runPrMiner(deps);

    expect(summary.created).toBe(true);
    // 読み取り 3 API は ghRead 側だけが呼ばれる(read = PAT / write = App の分離・ADR-0013 D4)
    expect(ghRead.listMergedPullRequests).toHaveBeenCalled();
    expect(ghRead.listPullRequestComments).toHaveBeenCalled();
    expect(ghRead.listPullRequestFiles).toHaveBeenCalled();
    expect(gh.listMergedPullRequests).not.toHaveBeenCalled();
    expect(gh.listPullRequestComments).not.toHaveBeenCalled();
    expect(gh.listPullRequestFiles).not.toHaveBeenCalled();
    // KB 側は gh のまま
    expect(gh.listPullRequests).toHaveBeenCalled();
    expect(gh.createPullRequest).toHaveBeenCalled();
    expect(ghRead.createPullRequest).not.toHaveBeenCalled();
  });

  it("happy path: 原本+カーソル+採番を 1 PR に載せ、head は週キー", async () => {
    const gh = makeGh();
    const { deps, written } = makeDeps({ gh });
    const summary = await runPrMiner(deps);

    expect(summary.created).toBe(true);
    expect(summary.minedPrs).toBe(1);
    const create = (gh.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      head: string;
      base: string;
      files: { path: string; content: string }[];
    };
    expect(create.head).toBe("pr-miner/2026-W28");
    expect(create.base).toBe("main");
    const paths = create.files.map((f) => f.path);
    expect(paths).toContain("_meta/pr-miner-state.json");
    expect(paths).toContain("_meta/id-counter.json");
    expect(paths.some((p) => p.startsWith("knowledge/gh-client/kb-"))).toBe(true);
    // カーソルは処理した PR の merged_at に前進
    const state = JSON.parse(written["/kb/_meta/pr-miner-state.json"] ?? "{}") as {
      repos: Record<string, { last_merged_at: string }>;
    };
    expect(state.repos["org/dev"]?.last_merged_at).toBe("2026-07-05T00:00:00Z");
    // pr source が付く
    const entry = create.files.find((f) => f.path.startsWith("knowledge/")) as { content: string };
    expect(entry.content).toContain('kind: "pr"');
    expect(entry.content).toContain("number: 10");
  });

  it("targets 空は disabled(gh を呼ばない)", async () => {
    const gh = makeGh();
    const { deps } = makeDeps({ gh, config: { ...config, targets: [] } });
    const summary = await runPrMiner(deps);
    expect(summary.reason).toBe("disabled");
    expect(gh.listMergedPullRequests).not.toHaveBeenCalled();
  });

  it("open な pr-miner/* PR があれば already-exists で保留", async () => {
    const gh = makeGh({
      listPullRequests: vi.fn(async () => [
        { number: 3, title: "先週分", headRef: "pr-miner/2026-W27", url: "u" },
      ]),
    });
    const { deps } = makeDeps({ gh });
    const summary = await runPrMiner(deps);
    expect(summary.reason).toBe("already-exists");
    expect(gh.listMergedPullRequests).not.toHaveBeenCalled();
  });

  it("候補ゼロ(抽出が空)は no-entries", async () => {
    const empty: ExtractionResult = { decisions: [], learnings: [], openQuestions: [] };
    const { deps } = makeDeps({
      extractDeps: {
        promptStore: { read: async () => "---\nrole: standard\n---\nR" },
        search: async () => ({ value: empty, usage: { inputTokens: 1, outputTokens: 1 } }),
      },
    });
    const summary = await runPrMiner(deps);
    expect(summary.reason).toBe("no-entries");
    expect(summary.minedPrs).toBe(1);
  });

  it("validateRepo 失敗は PR を作らない", async () => {
    const gh = makeGh();
    const { deps } = makeDeps({ gh, validate: async () => ({ ok: false, problems: [{}] }) });
    const summary = await runPrMiner(deps);
    expect(summary.reason).toBe("validation-failed");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
  });

  it("dry-run は実 PR を作らない", async () => {
    const gh = makeGh();
    const { deps } = makeDeps({ gh, realPr: false });
    const summary = await runPrMiner(deps);
    expect(summary.reason).toBe("dry-run");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
    // dry-run では冪等ガード(open PR 走査)も行わない
    expect(gh.listPullRequests).not.toHaveBeenCalled();
  });

  it("reconcile 失敗は該当候補を skip して続行", async () => {
    const gh = makeGh();
    const { deps } = makeDeps({
      gh,
      reconcileDeps: {
        promptStore: { read: async () => "---\nrole: standard\n---\nR" },
        search: async () => {
          throw new Error("reconcile boom");
        },
      },
    });
    const summary = await runPrMiner(deps);
    // 候補は skip され materialize 対象が無い → no-entries
    expect(summary.counts.skip).toBe(1);
    expect(summary.reason).toBe("no-entries");
  });

  it("リポ単位で失敗を隔離する(1 リポの API 失敗で全体を落とさない)", async () => {
    const gh = makeGh({
      listMergedPullRequests: vi.fn(async (repo: string) => {
        if (repo === "org/bad") throw new Error("API 500");
        return [mergedPr({ number: 10 })];
      }),
    });
    const { deps } = makeDeps({ gh, config: { ...config, targets: ["org/bad", "org/dev"] } });
    const summary = await runPrMiner(deps);
    expect(summary.created).toBe(true); // org/dev は処理された
    expect(summary.minedPrs).toBe(1);
  });

  it("カーソルは処理した PR の最大 merged_at に前進する", async () => {
    const gh = makeGh({
      listMergedPullRequests: vi.fn(async () => [
        mergedPr({ number: 10, mergedAt: "2026-07-05T00:00:00Z" }),
        mergedPr({ number: 11, mergedAt: "2026-07-07T00:00:00Z" }),
      ]),
    });
    const { deps, written } = makeDeps({ gh });
    await runPrMiner(deps);
    const state = JSON.parse(written["/kb/_meta/pr-miner-state.json"] ?? "{}") as {
      repos: Record<string, { last_merged_at: string }>;
    };
    expect(state.repos["org/dev"]?.last_merged_at).toBe("2026-07-07T00:00:00Z");
  });

  it("deciders 空の decision は PR author をフォールバックにする", async () => {
    const gh = makeGh();
    const { deps } = makeDeps({
      gh,
      extractDeps: {
        promptStore: { read: async () => "---\nrole: standard\n---\nR" },
        search: async () => ({
          value: oneDecisionNoDeciders,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    });
    const summary = await runPrMiner(deps);
    // author(yamada)があるので skip されず decision が materialize される
    expect(summary.counts.new).toBe(1);
    const create = (gh.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      files: { path: string; content: string }[];
    };
    const dr = create.files.find((f) => f.path.startsWith("decisions/")) as { content: string };
    expect(dr.content).toContain("yamada");
  });

  it("cursor 由来の since は境界を merged_at > cursor で除外する", async () => {
    const gh = makeGh({
      listMergedPullRequests: vi.fn(async () => [
        mergedPr({ number: 10, mergedAt: "2026-07-05T00:00:00Z" }), // = cursor → 除外
        mergedPr({ number: 11, mergedAt: "2026-07-06T00:00:00Z" }), // > cursor → 処理
      ]),
    });
    const stateRaw = JSON.stringify({
      repos: { "org/dev": { last_merged_at: "2026-07-05T00:00:00Z" } },
      last_run_at: "2026-07-02T00:00:00Z",
    });
    const { deps } = makeDeps({
      gh,
      readFile: async (p) => {
        if (p === "/kb/_meta/pr-miner-state.json") return stateRaw;
        if (p === "/kb/_meta/id-counter.json") return JSON.stringify({ kb: { "2026": 144 } });
        throw new Error(`ENOENT ${p}`);
      },
    });
    const summary = await runPrMiner(deps);
    expect(summary.minedPrs).toBe(1); // #10 は除外、#11 のみ
  });
});
