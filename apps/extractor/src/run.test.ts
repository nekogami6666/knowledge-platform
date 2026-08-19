import type {
  CommitSummary,
  GhClient,
  MergedPrSummary,
  PrCommentItem,
  PrFileSummary,
  PrSummary,
} from "@stratum/gh-client";
import { type IdKind, parseEntry } from "@stratum/kb-core";
import { describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "./candidate.js";
import type { ExtractorConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildPrTitle, buildRunKey } from "./pr-title.js";
import { type RunDeps, runExtractor } from "./run.js";
import type { Verdict } from "./verdict.js";

const HEAD = "abcdef1234567890"; // 小文字 hex(pr-title の正規表現に一致)
const KB_HEAD = "0123456fedcba987"; // kb clone の head(interviews カーソルの前進先・PR-I1)

const config: ExtractorConfig = {
  minutes: { repo: "org/minutes", dir: "minutes", exclude: ["transcript.md"] },
  kb: { repo: "org/knowledge-base", dir: "knowledge-base" },
  interviews: { dir: "interviews", exclude_dirs: ["kits", "voice-memos"] },
  base_branch: "main",
  participants_exclude: ["QB", "Recorder"],
  review_mentions: [],
};

/** 決定的な連番スタブ(実装は kb-core newId の乱数採番・ADR-0026)。suffix は base36 6文字。 */
function stubMakeId(): (kind: IdKind) => string {
  let n = 0;
  return (kind) => `${kind}-2026-t${String(++n).padStart(5, "0")}`;
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

function makeNotifier() {
  return { notifyPrCreated: vi.fn(async () => {}), notifySkipped: vi.fn(async () => {}) };
}

function makeDeps(over: Partial<RunDeps> = {}): RunDeps {
  const files: Record<string, string> = {
    "/m/2026/06/x.md": "# 会議\n参加者: yamada\n湿度しきい値を 40%RH 以下に更新。",
  };
  const prompt = { read: async () => "---\nrole: standard\n---\nRULES" };
  return {
    config,
    syncer: {
      sync: async () => ({
        minutes: { repo: "org/minutes", absDir: "/m", resolvedCommit: HEAD },
        kb: { repo: "org/knowledge-base", absDir: "/kb", resolvedCommit: KB_HEAD },
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
    makeId: stubMakeId(),
    validate: async () => ({ ok: true, problems: [] }),
    readFile: async (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async () => {},
    // pathspec で分岐(minutes は変更 1 件・interviews は変更なしが既定)。
    exec: async (args: readonly string[]) =>
      args.includes("interviews/*.md") ? { stdout: "" } : { stdout: "2026/06/x.md\n" },
    readdir: async () => [],
    notifier: makeNotifier(),
    now: () => new Date("2026-07-01T00:00:00Z"),
    logger: createLogger([], () => {}),
    realPr: true,
    reconcileConcurrency: 4,
    ...over,
  };
}

describe("runExtractor", () => {
  it("happy path: 1 PR を作成(state.json + entry を含む・id-counter は同梱しない)", async () => {
    const gh = makeGh();
    const notifier = makeNotifier();
    const r = await runExtractor(makeDeps({ gh, notifier }));
    expect(r.created).toBe(true);
    expect(r.prUrl).toBe("https://github.com/o/kb/pull/99");
    expect(gh.createPullRequest).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const paths = arg?.files.map((f) => f.path) ?? [];
    expect(paths).toContain("_meta/state.json");
    expect(paths).not.toContain("_meta/id-counter.json");
    expect(paths.some((p) => p.startsWith("knowledge/hardware/kb-2026-t00001"))).toBe(true);
    expect(arg?.title).toContain("abcdef1+0123456");
    // カーソルは両ソースとも同期時 head へ前進(PR-I1)。
    const state = JSON.parse(arg?.files.find((f) => f.path === "_meta/state.json")?.content ?? "");
    expect(state.sources).toEqual({
      minutes: { last_processed_sha: HEAD },
      interviews: { last_processed_sha: KB_HEAD },
    });
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

  it("未マージの抽出 PR が既存 → 冪等 skip", async () => {
    const existing: PrSummary = {
      number: 7,
      title: buildPrTitle(buildRunKey(HEAD, KB_HEAD)),
      headRef: `extract/${buildRunKey(HEAD, KB_HEAD)}`,
      url: "https://existing",
    };
    const gh = makeGh({ listPullRequests: vi.fn(async () => [existing]) });
    const r = await runExtractor(makeDeps({ gh }));
    expect(r.created).toBe(false);
    expect(r.reason).toBe("already-exists");
    expect(r.prUrl).toBe("https://existing");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
  });

  it("範囲(ランキー)が違う抽出 PR でも skip し、見送りを通知する", async () => {
    // 上流に新コミットが入るとランキーが変わる。範囲一致で判定していた頃はここでガードが外れ、
    // 未マージ PR が毎晩積み上がった(2026-07-29)。
    const existing: PrSummary = {
      number: 8,
      title: "extract: sources 0000000+1111111 ナレッジ抽出",
      headRef: "extract/0000000+1111111",
      url: "https://stale-pr",
    };
    const gh = makeGh({ listPullRequests: vi.fn(async () => [existing]) });
    const notifier = makeNotifier();
    const r = await runExtractor(makeDeps({ gh, notifier }));
    expect(r.created).toBe(false);
    expect(r.reason).toBe("already-exists");
    expect(r.prUrl).toBe("https://stale-pr");
    expect(gh.createPullRequest).not.toHaveBeenCalled();
    expect(notifier.notifySkipped).toHaveBeenCalledWith({ prUrl: "https://stale-pr" });
  });

  it("差分ゼロの夜でも滞留 PR があればリマインドを送る(ガードは diff 判定より先)", async () => {
    // 以前は「変更なし」の early return がガードより先にあり、議事録が動かない夜は滞留 PR の
    // リマインドが一切飛ばなかった(#35 が週末 3 晩リマインド無しで滞留した構造)。
    const existing: PrSummary = {
      number: 10,
      title: "extract: sources 0000000+1111111 ナレッジ抽出",
      headRef: "extract/0000000+1111111",
      url: "https://stale-pr",
    };
    const gh = makeGh({ listPullRequests: vi.fn(async () => [existing]) });
    const notifier = makeNotifier();
    const r = await runExtractor(makeDeps({ gh, notifier, exec: async () => ({ stdout: "" }) }));
    expect(r.created).toBe(false);
    expect(r.reason).toBe("already-exists");
    expect(notifier.notifySkipped).toHaveBeenCalledWith({ prUrl: "https://stale-pr" });
    expect(gh.createPullRequest).not.toHaveBeenCalled();
  });

  it("dry-run は差分ゼロなら gh に触れず no-changes(従来どおり)", async () => {
    const gh = makeGh();
    const r = await runExtractor(
      makeDeps({ gh, realPr: false, exec: async () => ({ stdout: "" }) }),
    );
    expect(r.created).toBe(false);
    expect(r.reason).toBe("no-changes");
    expect(gh.listPullRequests).not.toHaveBeenCalled();
  });

  it("抽出 PR 以外の open PR は skip の理由にならない", async () => {
    const unrelated: PrSummary = {
      number: 9,
      title: "docs: 無関係な PR",
      headRef: "docs/whatever",
      url: "https://unrelated",
    };
    const gh = makeGh({ listPullRequests: vi.fn(async () => [unrelated]) });
    const r = await runExtractor(makeDeps({ gh }));
    expect(r.reason).not.toBe("already-exists");
    expect(gh.createPullRequest).toHaveBeenCalled();
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

  it("interviews/ の変更は interview 出典 + 面談プロンプトで抽出される(第 2 ソース・PR-I1)", async () => {
    const gh = makeGh();
    const promptNames: string[] = [];
    const userPrompts: string[] = [];
    const r = await runExtractor(
      makeDeps({
        gh,
        // minutes は変更なし・interviews に 1 件。
        exec: async (args: readonly string[]) =>
          args.includes("interviews/*.md")
            ? { stdout: "interviews/2026-07-01-yamada.md\n" }
            : { stdout: "" },
        readFile: async (p) => {
          if (p === "/kb/interviews/2026-07-01-yamada.md") {
            return "# 面談\n参加者: yamada\n初期化は電源→センサの順。";
          }
          throw new Error(`ENOENT ${p}`);
        },
        extractDeps: {
          promptStore: {
            read: async (_app: string, name: string) => {
              promptNames.push(name);
              return "---\nrole: standard\n---\nRULES";
            },
          },
          search: async (opts) => {
            userPrompts.push(opts.prompt);
            return { value: oneLearning, usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
      }),
    );
    expect(r.created).toBe(true);
    expect(promptNames.some((n) => n.includes("extract-interview"))).toBe(true);
    expect(userPrompts.some((p) => p.includes("ナレッジインタビュー"))).toBe(true);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const entry = arg?.files.find((f) => f.path.startsWith("knowledge/"));
    expect(entry?.content).toContain('kind: "interview"');
    expect(entry?.content).toContain("interviews/2026-07-01-yamada.md");
    expect(entry?.content).toContain(KB_HEAD); // source.ref は kb head
  });

  it("段階別 timings を計測する(monotonicMs 注入)", async () => {
    let t = 0;
    const r = await runExtractor(makeDeps({ monotonicMs: () => (t += 5) }));
    expect(r.timings).toBeDefined();
    expect(typeof r.timings?.reconcileMs).toBe("number");
    expect(r.timings?.reconcileMs).toBeGreaterThanOrEqual(0);
  });

  it("抽出失敗のファイルは skip して完走し、次回へ持ち越す(ADR-0023 D1)", async () => {
    const gh = makeGh();
    const prompt = { read: async () => "---\nrole: standard\n---\nR" };
    const r = await runExtractor(
      makeDeps({
        gh,
        exec: async (args: readonly string[]) =>
          args.includes("interviews/*.md") ? { stdout: "" } : { stdout: "a.md\nb.md\n" },
        readFile: async (p) => {
          if (p === "/m/a.md") return "# 会議\n参加者: x\nPOISON 抽出でタイムアウトする議事録。";
          if (p === "/m/b.md") return "# 会議\n参加者: y\n湿度しきい値を 40%RH に更新。";
          throw new Error(`ENOENT ${p}`);
        },
        extractDeps: {
          promptStore: prompt,
          search: async (opts) => {
            if (opts.prompt.includes("POISON")) {
              throw new Error("Agent SDK query が 300000ms でタイムアウトしました");
            }
            return { value: oneLearning, usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
      }),
    );
    expect(r.created).toBe(true); // b.md は抽出成功 → PR は出る
    expect(r.skippedFiles).toEqual(["a.md"]);
    expect(r.counts.new).toBe(1);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const state = JSON.parse(arg?.files.find((f) => f.path === "_meta/state.json")?.content ?? "");
    // カーソルは head へ前進し、失敗した a.md は pending に持ち越す。
    expect(state.sources.minutes).toEqual({ last_processed_sha: HEAD, pending: ["a.md"] });
  });

  it("maxFilesPerRun を超えた分は今回処理せず持ち越す(ADR-0023 D3)", async () => {
    const gh = makeGh();
    const prompt = { read: async () => "---\nrole: standard\n---\nR" };
    const r = await runExtractor(
      makeDeps({
        gh,
        maxFilesPerRun: 2,
        exec: async (args: readonly string[]) =>
          args.includes("interviews/*.md") ? { stdout: "" } : { stdout: "a.md\nb.md\nc.md\n" },
        readFile: async (p) => {
          if (p === "/m/a.md") return "# 会議\nAAA";
          if (p === "/m/b.md") return "# 会議\nBBB";
          if (p === "/m/c.md") return "# 会議\nCCC";
          throw new Error(`ENOENT ${p}`);
        },
        extractDeps: {
          promptStore: prompt,
          search: async (opts) => ({
            value: opts.prompt.includes("AAA")
              ? extractionWithDomain("da")
              : opts.prompt.includes("BBB")
                ? extractionWithDomain("db")
                : extractionWithDomain("dc"),
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
      }),
    );
    expect(r.created).toBe(true);
    expect(r.deferredCount).toBe(1);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const state = JSON.parse(arg?.files.find((f) => f.path === "_meta/state.json")?.content ?? "");
    expect(state.sources.minutes).toEqual({ last_processed_sha: HEAD, pending: ["c.md"] });
    // 上限で c.md は未処理 = domain dc は作られない。
    const paths = arg?.files.map((f) => f.path) ?? [];
    expect(paths.some((p) => p.includes("/dc/"))).toBe(false);
  });

  it("前回 pending は work list 先頭で処理する(diff が空でも no-changes にしない・ADR-0023 D2)", async () => {
    const gh = makeGh();
    const r = await runExtractor(
      makeDeps({
        gh,
        exec: async () => ({ stdout: "" }), // 両ソースとも diff 空
        readFile: async (p) => {
          if (p === "/kb/_meta/state.json") {
            return JSON.stringify({
              sources: { minutes: { last_processed_sha: "oldsha", pending: ["p.md"] } },
              last_run_at: "2026-07-01T00:00:00.000Z",
            });
          }
          if (p === "/m/p.md") return "# 会議\n参加者: z\n湿度しきい値を 40%RH に更新。";
          throw new Error(`ENOENT ${p}`);
        },
      }),
    );
    expect(r.created).toBe(true);
    expect(r.reason).toBeUndefined();
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const state = JSON.parse(arg?.files.find((f) => f.path === "_meta/state.json")?.content ?? "");
    // p.md 処理済み → pending は消え、カーソルは head。
    expect(state.sources.minutes).toEqual({ last_processed_sha: HEAD });
  });

  it("people 空の learning は参加者を owner にせず unassigned(ADR-0027 D1・extractor 経路)", async () => {
    const gh = makeGh();
    const logs: string[] = [];
    const noPeople: ExtractionResult = {
      decisions: [],
      learnings: [
        {
          kind: "learning",
          title: "t",
          body: "b",
          entryType: "fact",
          domain: "hardware",
          people: [],
          tags: [],
          confidence: "high",
          slug: "t",
        },
      ],
      openQuestions: [],
    };
    const r = await runExtractor(
      makeDeps({
        gh,
        logger: createLogger([], (l) => logs.push(l)),
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({ value: noPeople, usage: { inputTokens: 1, outputTokens: 1 } }),
        },
      }),
    );
    expect(r.created).toBe(true);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const entry = arg?.files.find((f) => f.path.startsWith("knowledge/"));
    expect(entry?.content).toContain('owner: "unassigned"'); // 参加者 yamada を owner にしない
    // members.yaml が無い環境では warn して正規化なしで続行する。
    expect(logs.some((l) => l.includes("members.yaml"))).toBe(true);
  });

  it("機械ガードが配線される: 未確定 decision は降格・安全 learning は low 強制(ADR-0027 D2)", async () => {
    const gh = makeGh();
    const guarded: ExtractionResult = {
      decisions: [
        {
          kind: "decision",
          title: "X 方式の採用",
          decision: "X 方式を検討する。",
          deciders: ["yamada"],
          confidence: "high",
        },
      ],
      learnings: [
        {
          kind: "learning",
          title: "分電盤の配線手順",
          body: "AC100V 系統の配線は主幹を落としてから行う。",
          entryType: "procedure",
          domain: "hardware",
          people: ["yamada"],
          tags: [],
          confidence: "high",
          slug: "wiring",
        },
      ],
      openQuestions: [],
    };
    const r = await runExtractor(
      makeDeps({
        gh,
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({ value: guarded, usage: { inputTokens: 1, outputTokens: 1 } }),
        },
      }),
    );
    expect(r.guards).toEqual({ demotedDecisions: 1, safetyFlagged: 1 });
    expect(r.counts.new).toBe(1); // 降格された decision は materialize されない
    expect(r.counts.openQuestions).toBe(2); // 降格 1 + 安全の確認質問 1
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const entry = arg?.files.find((f) => f.path.startsWith("knowledge/"));
    expect(entry?.content).toContain('confidence: "low"');
    expect(entry?.content).toContain("要確認");
    expect(arg?.body).toContain("決定→問いへ降格: 1 件");
    expect(arg?.body).toContain("安全情報のため要確認");
  });

  it("決定者不明で skip した decision は open question として起票される(ADR-0027 D1/D3)", async () => {
    const gh = makeGh();
    const noDeciders: ExtractionResult = {
      decisions: [
        {
          kind: "decision",
          title: "Z 案の採用",
          decision: "Z 案を採用する。",
          deciders: [],
          confidence: "medium",
          lines: "L5-L8",
        },
      ],
      learnings: [],
      openQuestions: [],
    };
    const r = await runExtractor(
      makeDeps({
        gh,
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({ value: noDeciders, usage: { inputTokens: 1, outputTokens: 1 } }),
        },
      }),
    );
    expect(r.counts.skip).toBe(1); // decision 自体は skip
    expect(r.counts.openQuestions).toBe(1); // ただし問いとして残る
    expect(r.created).toBe(true);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const q = arg?.files.find((f) => f.path.startsWith("questions/open/q-"));
    expect(q?.content).toContain("Z 案の採用");
    expect(q?.content).toContain("決定者を特定できなかった");
  });

  it("review_mentions 設定時は PR 作成・冪等 skip の両通知にレビュー担当が渡る(㉘)", async () => {
    const withReviewer: ExtractorConfig = { ...config, review_mentions: ["999"] };
    const notifier = makeNotifier();
    const r = await runExtractor(makeDeps({ config: withReviewer, notifier }));
    expect(r.created).toBe(true);
    expect(notifier.notifyPrCreated).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer: "999" }),
    );

    const existing: PrSummary = {
      number: 7,
      title: buildPrTitle(buildRunKey(HEAD, KB_HEAD)),
      headRef: `extract/${buildRunKey(HEAD, KB_HEAD)}`,
      url: "https://existing",
    };
    const notifier2 = makeNotifier();
    const gh = makeGh({ listPullRequests: vi.fn(async () => [existing]) });
    await runExtractor(makeDeps({ config: withReviewer, notifier: notifier2, gh }));
    expect(notifier2.notifySkipped).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer: "999" }),
    );
  });

  it("review_mentions 複数名は日数で交代する(日替わりローテーション・㉘)", async () => {
    const withReviewers: ExtractorConfig = { ...config, review_mentions: ["aaa", "bbb"] };
    const day = 86_400_000;
    // 偶数日 → index 0、翌日 → index 1(gap-tracker の rr と同じ日数基準)
    const notifier = makeNotifier();
    await runExtractor(
      makeDeps({ config: withReviewers, notifier, now: () => new Date(day * 20000) }),
    );
    expect(notifier.notifyPrCreated).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer: "aaa" }),
    );
    const notifier2 = makeNotifier();
    await runExtractor(
      makeDeps({ config: withReviewers, notifier: notifier2, now: () => new Date(day * 20001) }),
    );
    expect(notifier2.notifyPrCreated).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer: "bbb" }),
    );
  });

  it("openQuestions は QuestionLog として questions/open へ起票され PR に同梱される(ADR-0027 D3・検証テスト8)", async () => {
    const gh = makeGh();
    const withQuestions: ExtractionResult = {
      ...oneLearning,
      openQuestions: [
        {
          kind: "open_question",
          title: "分注ロボットの耐湿仕様は?",
          body: "両説が出て確定しなかった。",
          lines: "L3",
        },
      ],
    };
    const r = await runExtractor(
      makeDeps({
        gh,
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({
            value: withQuestions,
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
      }),
    );
    expect(r.created).toBe(true);
    expect(r.counts.openQuestions).toBe(1); // 「起票した件数」
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const qFile = arg?.files.find((f) => f.path.startsWith("questions/open/q-2026-"));
    expect(qFile).toBeDefined();
    // frontmatter は kb-core questionLogSchema に完全準拠(parseEntry round-trip)。
    const back = parseEntry(qFile?.content ?? "", "question", qFile?.path);
    expect(back.frontmatter.asked_by).toBe("extractor"); // 機械起票の規約値
    expect(back.frontmatter.status).toBe("open");
    expect(back.frontmatter.question).toBe("分注ロボットの耐湿仕様は?");
    // 本文に元議事録(repo/path/ref/lines)への言及がある。
    expect(back.body).toContain("org/minutes");
    expect(back.body).toContain("2026/06/x.md");
    expect(back.body).toContain(HEAD);
    expect(back.body).toContain("L3");
    expect(arg?.body).toContain("未解決の問い(questions/open に起票): 1");
  });

  it("源泉日(議事録パスの日付)が asked_at と ID 採番の年に反映される(ADR-0027 D3 / ADR-0026 D3)", async () => {
    const gh = makeGh();
    const idMoments: (Date | undefined)[] = [];
    let n = 0;
    const makeId = (kind: IdKind, now?: Date): string => {
      if (kind === "q") idMoments.push(now);
      return `${kind}-2026-t${String(++n).padStart(5, "0")}`;
    };
    const withQuestion: ExtractionResult = {
      decisions: [],
      learnings: [],
      openQuestions: [{ kind: "open_question", title: "湿度上限は?", body: "未確定。" }],
    };
    const r = await runExtractor(
      makeDeps({
        gh,
        makeId,
        exec: async (args: readonly string[]) =>
          args.includes("interviews/*.md")
            ? { stdout: "" }
            : { stdout: "2026-06-03-hw-weekly.md\n" },
        readFile: async (p) => {
          if (p === "/m/2026-06-03-hw-weekly.md") return "# 会議\n参加者: yamada\n湿度は未確定。";
          throw new Error(`ENOENT ${p}`);
        },
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({ value: withQuestion, usage: { inputTokens: 1, outputTokens: 1 } }),
        },
      }),
    );
    expect(r.created).toBe(true); // 問いのみでも PR になる(件数カウント破棄の反転)
    // makeId("q", 源泉日): ID の年は源泉日基準(kb-core newId の now 引数)。
    expect(idMoments).toEqual([new Date("2026-06-03T00:00:00+09:00")]);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const qFile = arg?.files.find((f) => f.path.startsWith("questions/open/"));
    const back = parseEntry(qFile?.content ?? "", "question", qFile?.path);
    expect(back.frontmatter.asked_at).toBe("2026-06-03T00:00:00+09:00"); // 源泉日(JST)
  });

  it("ガードで降格された decision 由来の問いも questions/open へ起票される(ADR-0027 D2→D3)", async () => {
    const gh = makeGh();
    const uncertain: ExtractionResult = {
      decisions: [
        {
          kind: "decision",
          title: "X 方式の採用",
          decision: "X 方式を検討する。",
          deciders: ["yamada"],
          confidence: "high",
        },
      ],
      learnings: [],
      openQuestions: [],
    };
    const r = await runExtractor(
      makeDeps({
        gh,
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({ value: uncertain, usage: { inputTokens: 1, outputTokens: 1 } }),
        },
      }),
    );
    expect(r.guards.demotedDecisions).toBe(1);
    expect(r.counts.openQuestions).toBe(1);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const qFile = arg?.files.find((f) => f.path.startsWith("questions/open/"));
    const back = parseEntry(qFile?.content ?? "", "question", qFile?.path);
    expect(back.frontmatter.question).toBe("X 方式の採用");
    expect(back.body).toContain("機械ガードで decision から降格");
  });

  it("同一 run 内の同 title の問いは重複起票しない(既存 KB との突合はしない)", async () => {
    const gh = makeGh();
    const duplicated: ExtractionResult = {
      ...oneLearning,
      openQuestions: [
        { kind: "open_question", title: "湿度上限は?", body: "a" },
        { kind: "open_question", title: "湿度上限は?", body: "b" },
      ],
    };
    const r = await runExtractor(
      makeDeps({
        gh,
        extractDeps: {
          promptStore: { read: async () => "---\nrole: standard\n---\nR" },
          search: async () => ({ value: duplicated, usage: { inputTokens: 1, outputTokens: 1 } }),
        },
      }),
    );
    expect(r.counts.openQuestions).toBe(1);
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const qFiles = arg?.files.filter((f) => f.path.startsWith("questions/open/")) ?? [];
    expect(qFiles).toHaveLength(1);
  });

  it("読めない pending は破棄して pending から外す(無限再キュー防止・ADR-0023 D1)", async () => {
    const gh = makeGh();
    const logs: string[] = [];
    const r = await runExtractor(
      makeDeps({
        gh,
        logger: createLogger([], (l) => logs.push(l)),
        exec: async (args: readonly string[]) =>
          args.includes("interviews/*.md") ? { stdout: "" } : { stdout: "ok.md\n" },
        readFile: async (p) => {
          if (p === "/kb/_meta/state.json") {
            return JSON.stringify({
              sources: { minutes: { last_processed_sha: "oldsha", pending: ["gone.md"] } },
              last_run_at: "2026-07-01T00:00:00.000Z",
            });
          }
          if (p === "/m/ok.md") return "# 会議\n参加者: z\n湿度しきい値を 40%RH に更新。";
          throw new Error(`ENOENT ${p}`); // gone.md を含む
        },
      }),
    );
    expect(r.created).toBe(true);
    expect(r.skippedFiles).toEqual([]); // read 失敗は「持ち越し」ではなく「破棄」
    const arg = vi.mocked(gh.createPullRequest).mock.calls[0]?.[0];
    const state = JSON.parse(arg?.files.find((f) => f.path === "_meta/state.json")?.content ?? "");
    expect(state.sources.minutes).toEqual({ last_processed_sha: HEAD }); // gone.md は pending に残らない
    expect(logs.some((l) => l.includes("読めない"))).toBe(true);
  });
});
