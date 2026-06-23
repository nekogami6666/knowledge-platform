import type { PromptStore, Usage } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import {
  type AskDeps,
  type AskRequest,
  buildRepoManifest,
  handleAskRequest,
  NOT_FOUND_MESSAGE,
  type QaAnswer,
  type QaCitation,
  validateCitations,
} from "./ask.js";
import { SerialQueue } from "./concurrency.js";
import { type BotStore, createMemoryStore } from "./db.js";
import type { RepoSpec, RepoSyncer, SyncedRepo } from "./repos.js";

const synced: SyncedRepo[] = [
  { repo: "org/minutes", absDir: "/clones/minutes", resolvedCommit: "sha-min" },
];

describe("validateCitations (修正5: LLM 返却を信頼しない多層検証)", () => {
  const exists = (p: string): boolean => p === "/clones/minutes/2026/x.md";

  it("正当な github_file は ref=resolvedCommit を付与して通す", () => {
    const cs: QaCitation[] = [
      { kind: "github_file", repo: "org/minutes", path: "2026/x.md", lines: "L5-L9" },
    ];
    expect(validateCitations(cs, synced, exists)).toEqual([
      {
        kind: "github_file",
        repo: "org/minutes",
        path: "2026/x.md",
        ref: "sha-min",
        lines: "L5-L9",
      },
    ]);
  });

  it("allowlist 外の repo は破棄", () => {
    const cs: QaCitation[] = [{ kind: "github_file", repo: "evil/repo", path: "2026/x.md" }];
    expect(validateCitations(cs, synced, exists)).toEqual([]);
  });

  it("path トラバーサル(..)は破棄", () => {
    const cs: QaCitation[] = [{ kind: "github_file", repo: "org/minutes", path: "../secret" }];
    expect(validateCitations(cs, synced, exists)).toEqual([]);
  });

  it("実在しないファイルは破棄", () => {
    const cs: QaCitation[] = [
      { kind: "github_file", repo: "org/minutes", path: "2026/missing.md" },
    ];
    expect(validateCitations(cs, synced, exists)).toEqual([]);
  });

  it("不正な lines(形式不正・逆順範囲・0開始)は破棄(kb-core parseLineRange に委譲)", () => {
    for (const lines of ["10-20", "L9-L5", "L0"]) {
      const cs: QaCitation[] = [
        { kind: "github_file", repo: "org/minutes", path: "2026/x.md", lines },
      ];
      expect(validateCitations(cs, synced, exists)).toEqual([]);
    }
  });

  it("github_pr は allowlist 内なら通す", () => {
    const cs: QaCitation[] = [{ kind: "github_pr", repo: "org/minutes", number: 3 }];
    expect(validateCitations(cs, synced, exists)).toEqual([
      { kind: "github_pr", repo: "org/minutes", number: 3 },
    ]);
  });

  it("discord は permalink 形式のみ通す", () => {
    const ok: QaCitation[] = [{ kind: "discord", url: "https://discord.com/channels/1/2/3" }];
    const ng: QaCitation[] = [{ kind: "discord", url: "https://evil.example/x" }];
    expect(validateCitations(ok, synced, exists)).toHaveLength(1);
    expect(validateCitations(ng, synced, exists)).toEqual([]);
  });
});

// --- synthetic 統合テスト(修正5: /ask パイプライン end-to-end・全SDKモック) ---

function fakeSyncer(): RepoSyncer {
  return { sync: async () => synced };
}
const repos: RepoSpec[] = [{ repo: "org/minutes", dir: "minutes" }];
const promptStore: PromptStore = {
  read: async () => "---\nrole: standard\n---\nQ&A システムプロンプト本文",
};

function counterId(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

function makeDeps(over: Partial<AskDeps> = {}): { deps: AskDeps; store: BotStore } {
  const store = createMemoryStore();
  const deps: AskDeps = {
    repos,
    syncer: fakeSyncer(),
    promptStore,
    store,
    clonesDir: "/clones",
    search: async () => ({
      value: { answer: "回答", citations: [], notFound: true },
      usage: { inputTokens: 3, outputTokens: 4 } satisfies Usage,
    }),
    newId: counterId(),
    now: () => "2026-06-17T10:00:00+09:00",
    fileExists: () => true,
    ...over,
  };
  return { deps, store };
}

const req: AskRequest = {
  question: "分注機の温度補正は?",
  discordUserId: "u1",
  discordChannelId: "ch1",
  threadId: null,
  correlationId: "corr-1",
};

describe("buildRepoManifest (§6.2 repo 対応表)", () => {
  it("repo ごとに org/name → subdir 行を組む", () => {
    const m = buildRepoManifest([
      { repo: "org/minutes", dir: "minutes" },
      { repo: "org/fw", dir: "dispenser-fw" },
    ]);
    expect(m).toContain("org/minutes → サブディレクトリ `minutes/`");
    expect(m).toContain("org/fw → サブディレクトリ `dispenser-fw/`");
  });

  it("repos が空なら空文字(前置きしない)", () => {
    expect(buildRepoManifest([])).toBe("");
  });
});

describe("handleAskRequest synthetic 統合(§6.2 受け入れ条件)", () => {
  it("systemPrompt に repo manifest とプロンプト本文を前置きして検索する(PR-6a)", async () => {
    let capturedSystemPrompt = "";
    const { deps } = makeDeps({
      search: async (input) => {
        capturedSystemPrompt = input.systemPrompt;
        return {
          value: { answer: "ok", citations: [], notFound: true },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    await handleAskRequest(req, deps);
    expect(capturedSystemPrompt).toContain("org/minutes → サブディレクトリ `minutes/`");
    expect(capturedSystemPrompt).toContain("Q&A システムプロンプト本文");
  });

  it("AC1: 出典付き回答 → answered で queries に記録(出典脚注つき)", async () => {
    const answer: QaAnswer = {
      answer: "温度補正は入っています。",
      citations: [{ kind: "github_file", repo: "org/minutes", path: "2026/x.md", lines: "L5" }],
      notFound: false,
    };
    const { deps, store } = makeDeps({
      search: async () => ({ value: answer, usage: { inputTokens: 10, outputTokens: 20 } }),
    });
    const res = await handleAskRequest(req, deps);

    expect(res.status).toBe("answered");
    expect(res.answerText).toContain("温度補正は入っています。");
    expect(res.answerText).toContain("https://github.com/org/minutes/blob/sha-min/2026/x.md#L5");
    const q = store.getQuery(res.queryId);
    expect(q?.answerStatus).toBe("answered");
    expect(q?.correlationId).toBe("corr-1");
    expect(q?.sourcesJson).toContain("github_file");
    expect(store.listPendingActions("question_queue")).toHaveLength(0);
  });

  it("AC2: notFound → 捏造せず未回答 + pending_actions に積む(git 書き込みなし)", async () => {
    const { deps, store } = makeDeps(); // 既定 search が notFound:true
    const res = await handleAskRequest(req, deps);

    expect(res.status).toBe("unanswered");
    expect(res.answerText).toBe(NOT_FOUND_MESSAGE);
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("unanswered");
    expect(store.getQuery(res.queryId)?.answer).toBeNull();
    const queued = store.listPendingActions("question_queue");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.queryId).toBe(res.queryId);
  });

  it("出典が全滅(allowlist 外のみ)したら notFound に倒す", async () => {
    const { deps, store } = makeDeps({
      search: async () => ({
        value: {
          answer: "それらしい回答",
          citations: [{ kind: "github_file", repo: "evil/repo", path: "x.md" }],
          notFound: false,
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("unanswered");
    expect(store.listPendingActions("question_queue")).toHaveLength(1);
  });

  it("検索が throw したら error として記録 + logError 通知(キューには積まない)", async () => {
    const errors: unknown[] = [];
    const { deps, store } = makeDeps({
      search: async () => {
        throw new Error("boom");
      },
      logError: (e) => errors.push(e),
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("error");
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("error");
    expect(store.listPendingActions()).toHaveLength(0);
    expect(errors).toHaveLength(1); // §7.4: エラーは握りつぶさず観測フックへ
  });

  it("§6.2 step5: elapsedMs を monotonic 差分で記録する(常に null ではない)", async () => {
    // monotonicMs は startedAt(1回目)と recordQuery(2回目)で呼ばれる → 250-100=150ms。
    const ticks = [100, 250];
    let i = 0;
    const { deps, store } = makeDeps({ monotonicMs: () => ticks[i++] ?? 0 });
    const res = await handleAskRequest(req, deps);
    expect(store.getQuery(res.queryId)?.elapsedMs).toBe(150);
  });

  it("AC3: 直列キュー経由で 3 件同時に投げても全て解決しクラッシュしない", async () => {
    const { deps, store } = makeDeps({
      search: async () => ({
        value: { answer: "ok", citations: [], notFound: true },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });
    const q = new SerialQueue();
    const results = await Promise.all([
      q.enqueue(() => handleAskRequest(req, deps)),
      q.enqueue(() => handleAskRequest(req, deps)),
      q.enqueue(() => handleAskRequest(req, deps)),
    ]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.queryId !== "")).toBe(true);
    expect(store.listQueries()).toHaveLength(3);
  });
});
