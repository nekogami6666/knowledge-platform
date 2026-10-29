import {
  type AgentQueryFn,
  LlmError,
  type PromptStore,
  runAgentSearch,
  type Usage,
} from "@stratum/llm";
import { describe, expect, it } from "vitest";
import {
  type AskDeps,
  type AskRequest,
  buildRepoManifest,
  DEADLINE_SKIPPED_MESSAGE,
  DEFAULT_ASK_TIMEOUT_MS,
  degenerateAnswerReason,
  ERROR_MESSAGE,
  handleAskRequest,
  INTERRUPTED_MESSAGE,
  MANIFEST_DESCRIPTION_MAX_CHARS,
  NOT_FOUND_MESSAGE,
  normalizeLineRange,
  type QaAnswer,
  type QaCitation,
  qaAnswerSchema,
  recordSkippedAsk,
  sanitizeRepoDescription,
  syncFailedMessage,
  timeoutMessage,
  validateCitations,
} from "./ask.js";
import { SerialQueue } from "./concurrency.js";
import { type BotStore, createMemoryStore } from "./db.js";
import { createRepoRegistry, type RepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";
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

  it("不正な lines(解釈不能・逆順範囲・0開始)は破棄(kb-core parseLineRange に委譲)", () => {
    for (const lines of ["L9-L5", "L0", "abc", "L5,L9"]) {
      const cs: QaCitation[] = [
        { kind: "github_file", repo: "org/minutes", path: "2026/x.md", lines },
      ];
      expect(validateCitations(cs, synced, exists)).toEqual([]);
    }
  });

  it("lines の表記ゆれは正典形式へ正規化して通す(実在検証済みの出典を書式で全損させない)", () => {
    const cases: Array<[string, string]> = [
      ["26", "L26"],
      ["26-31", "L26-L31"],
      ["L26-31", "L26-L31"],
      ["l26", "L26"],
      ["10-20", "L10-L20"],
    ];
    for (const [input, canonical] of cases) {
      const cs: QaCitation[] = [
        { kind: "github_file", repo: "org/minutes", path: "2026/x.md", lines: input },
      ];
      expect(validateCitations(cs, synced, exists)).toEqual([
        {
          kind: "github_file",
          repo: "org/minutes",
          path: "2026/x.md",
          ref: "sha-min",
          lines: canonical,
        },
      ]);
    }
  });

  it("normalizeLineRange: 一意に解釈できるものだけ正典化、それ以外は undefined", () => {
    expect(normalizeLineRange(" 26 ")).toBe("L26");
    expect(normalizeLineRange("L120-L141")).toBe("L120-L141");
    expect(normalizeLineRange("026")).toBe("L26");
    expect(normalizeLineRange("L05-L09")).toBe("L5-L9");
    expect(normalizeLineRange("L9-L5")).toBeUndefined();
    expect(normalizeLineRange("0")).toBeUndefined();
    expect(normalizeLineRange("")).toBeUndefined();
    expect(normalizeLineRange("五行目")).toBeUndefined();
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

  it("ADR-0038 D7: 許可集合を渡したら、今回ツールが返した permalink の discord 引用だけ通す", () => {
    const returned = "https://discord.com/channels/1/2/3";
    const other = "https://discord.com/channels/1/9/9"; // 形式は正しいが返していない(捏造・KB から写した等)
    const cs: QaCitation[] = [
      { kind: "discord", url: returned },
      { kind: "discord", url: other },
      { kind: "github_pr", repo: "org/minutes", number: 3 },
    ];
    const noop = () => null;
    expect(validateCitations(cs, synced, exists, noop, new Set([returned]))).toEqual([
      { kind: "discord", url: returned },
      { kind: "github_pr", repo: "org/minutes", number: 3 },
    ]);
    // 機能有効だがツールが何も返していない → discord 引用は全て破棄。
    expect(validateCitations(cs, synced, exists, noop, new Set())).toEqual([
      { kind: "github_pr", repo: "org/minutes", number: 3 },
    ]);
  });
});

describe("stale KB 注記(§6.7 / C8: stale エントリの引用は除外せずフラグを付けて通す)", () => {
  const STALE_ENTRY = `---
id: kb-2026-0001
title: 古い知識
type: fact
domain: hardware
tags: []
sources:
  - kind: discord
    url: "https://discord.com/channels/1/2/3"
confidence: high
status: stale
created: "2026-01-10"
last_verified: "2026-01-10"
owner: yamada
---

本文
`;
  const ACTIVE_ENTRY = STALE_ENTRY.replace("status: stale", "status: active");
  const kbSynced: SyncedRepo[] = [
    { repo: "org/knowledge-base", absDir: "/clones/kb", resolvedCommit: "sha-kb" },
  ];
  const exists = (): boolean => true;
  const cite = (path: string): QaCitation[] => [
    { kind: "github_file", repo: "org/knowledge-base", path },
  ];

  it("stale エントリは stale: true 付きで通す", () => {
    const out = validateCitations(
      cite("knowledge/hardware/x.md"),
      kbSynced,
      exists,
      () => STALE_ENTRY,
    );
    expect(out).toEqual([
      {
        kind: "github_file",
        repo: "org/knowledge-base",
        path: "knowledge/hardware/x.md",
        ref: "sha-kb",
        stale: true,
      },
    ]);
  });

  it("active エントリには stale キーを付けない", () => {
    const out = validateCitations(
      cite("knowledge/hardware/x.md"),
      kbSynced,
      exists,
      () => ACTIVE_ENTRY,
    );
    expect(out).toEqual([
      {
        kind: "github_file",
        repo: "org/knowledge-base",
        path: "knowledge/hardware/x.md",
        ref: "sha-kb",
      },
    ]);
  });

  it("KB スキーマでない .md(議事録など)は判定対象外(注記なしで通す)", () => {
    const out = validateCitations(
      cite("2026/minutes.md"),
      kbSynced,
      exists,
      () => "# 議事録\n本文\n",
    );
    expect(out[0]).not.toHaveProperty("stale");
  });

  it("読み取り失敗(null)でも引用自体は壊さない", () => {
    const out = validateCitations(cite("knowledge/hardware/x.md"), kbSynced, exists, () => null);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("stale");
  });

  it(".md 以外の引用ではファイルを読まない", () => {
    let called = 0;
    const readFile = (): string | null => {
      called += 1;
      return null;
    };
    const out = validateCitations(cite("src/main.ts"), kbSynced, exists, readFile);
    expect(out).toHaveLength(1);
    expect(called).toBe(0);
  });
});

// --- synthetic 統合テスト(修正5: /ask パイプライン end-to-end・全SDKモック) ---

function fakeSyncer(): RepoSyncer {
  const notLegacy = async (): Promise<never> => {
    throw new Error("従来モードではリポ単位の操作を呼ばない");
  };
  return {
    sync: async () => synced,
    syncEach: notLegacy,
    resolveHead: notLegacy,
    inspect: notLegacy,
    restoreHead: notLegacy,
    fetchTimeOnDisk: notLegacy,
  };
}
const repos: ScopedRepo[] = [
  { repo: "org/minutes", dir: "minutes", syncOnAsk: true, managed: false },
];
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
    getRepos: () => repos,
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

  it("description が無いリポは従来と同じ行(org/name の順に並べる)", () => {
    expect(
      buildRepoManifest([
        { repo: "org/minutes", dir: "minutes" },
        { repo: "org/fw", dir: "dispenser-fw", description: "   " },
      ]),
    ).toBe(
      [
        "## 検索対象リポジトリ(このコーパスでの対応)",
        "- org/fw → サブディレクトリ `dispenser-fw/`",
        "- org/minutes → サブディレクトリ `minutes/`",
        "引用の repo にはこの org/name を使い、path は各サブディレクトリ配下からの相対パスにすること。",
        "",
      ].join("\n"),
    );
  });

  it("description があればその行だけ末尾に ` — 説明` を足す(ADR-0036 D6)", () => {
    const m = buildRepoManifest([
      { repo: "org/minutes", dir: "minutes", description: "開発定例の議事録" },
      { repo: "org/fw", dir: "dispenser-fw" },
    ]);
    expect(m).toContain("- org/minutes → サブディレクトリ `minutes/` — 開発定例の議事録\n");
    expect(m).toContain("- org/fw → サブディレクトリ `dispenser-fw/`\n");
  });

  it("入力の順序に依らず同じリポ集合なら同じバイト列(プロンプトキャッシュを効かせる)", () => {
    const a = { repo: "org/minutes", dir: "minutes", description: "議事録" };
    const b = { repo: "org/kb", dir: "kb" };
    const c = { repo: "org/app", dir: "app-2" };
    const d = { repo: "org/app", dir: "app-1" };
    const m = buildRepoManifest([a, b, c, d]);
    expect(buildRepoManifest([d, c, b, a])).toBe(m);
    expect(buildRepoManifest([b, d, a, c])).toBe(m);
    expect(m.split("\n").slice(1, 5)).toEqual([
      "- org/app → サブディレクトリ `app-1/`",
      "- org/app → サブディレクトリ `app-2/`",
      "- org/kb → サブディレクトリ `kb/`",
      "- org/minutes → サブディレクトリ `minutes/` — 議事録",
    ]);
  });

  it("description の改行・連続空白は 1 行に畳み、manifest の行構造を壊さない", () => {
    const m = buildRepoManifest([
      { repo: "org/kb", dir: "kb", description: "  社内ナレッジ\n## 見出し風\r\n\t本文  " },
    ]);
    expect(m).toContain("- org/kb → サブディレクトリ `kb/` — 社内ナレッジ ## 見出し風 本文\n");
    expect(m.split("\n")).toHaveLength(4); // 見出し + 1 行 + 注記 + 末尾空行
  });
});

describe("sanitizeRepoDescription", () => {
  it("上限以内はそのまま、空・空白のみ・undefined は undefined", () => {
    expect(sanitizeRepoDescription("勤怠管理システム")).toBe("勤怠管理システム");
    expect(sanitizeRepoDescription("")).toBeUndefined();
    expect(sanitizeRepoDescription(" \n ")).toBeUndefined();
    expect(sanitizeRepoDescription(undefined)).toBeUndefined();
  });

  it("上限を超えたら上限文字数ちょうどに切り詰めて末尾を「…」にする", () => {
    const exact = "あ".repeat(MANIFEST_DESCRIPTION_MAX_CHARS);
    expect(sanitizeRepoDescription(exact)).toBe(exact);
    const out = sanitizeRepoDescription("あ".repeat(MANIFEST_DESCRIPTION_MAX_CHARS + 50));
    expect(out).toBe(`${"あ".repeat(MANIFEST_DESCRIPTION_MAX_CHARS - 1)}…`);
    expect(Array.from(out ?? "")).toHaveLength(MANIFEST_DESCRIPTION_MAX_CHARS);
  });

  it("切り詰めでサロゲートペア(絵文字)を割らない", () => {
    const out = sanitizeRepoDescription("🧪".repeat(MANIFEST_DESCRIPTION_MAX_CHARS + 1)) ?? "";
    // 期待値一致 = 末尾が完全な 🧪 + 「…」で、孤立サロゲートが残っていない。
    expect(out).toBe(`${"🧪".repeat(MANIFEST_DESCRIPTION_MAX_CHARS - 1)}…`);
  });
});

describe("handleAskRequest synthetic 統合(§6.2 受け入れ条件)", () => {
  it("systemPrompt はプロンプト本文だけ、repo manifest は後半(systemPromptDynamic)に分けて渡す(PR-6a・キャッシュ)", async () => {
    let captured: { systemPrompt: string; systemPromptDynamic?: string } | undefined;
    const { deps } = makeDeps({
      search: async (input) => {
        captured = input;
        return {
          value: { answer: "ok", citations: [], notFound: true },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    await handleAskRequest(req, deps);
    // 静的な本文が先頭(manifest が変わってもキャッシュの前半は同じバイト列)。
    expect(captured?.systemPrompt).toBe("Q&A システムプロンプト本文");
    expect(captured?.systemPromptDynamic).toContain("org/minutes → サブディレクトリ `minutes/`");
    expect(captured?.systemPromptDynamic).not.toContain("Q&A システムプロンプト本文");
  });

  it("ADR-0041: System One 未指定(ASK_FASTPATH=off)なら promptPrefix を渡さない", async () => {
    const inputs: Record<string, unknown>[] = [];
    const { deps } = makeDeps({
      search: async (input) => {
        inputs.push({ ...input });
        return {
          value: { answer: "ok", citations: [], notFound: true },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    await handleAskRequest(req, deps);
    expect("promptPrefix" in (inputs[0] ?? {})).toBe(false);
    expect(inputs[0]?.question).toBe(req.question);
  });

  it("ADR-0041: System One があれば同期後に候補ブロックを作って検索へ渡し、検証済みの引用を記録する", async () => {
    const calls: unknown[] = [];
    let prefix: unknown;
    const { deps } = makeDeps({
      systemOne: {
        mode: "on",
        prepare: async (input) => {
          calls.push({ prepare: input.queryId, q: input.question, synced: input.synced.length });
          return "## 候補(System One・確信度: 高)";
        },
        recordCited: (queryId, cited) => calls.push({ cited: queryId, n: cited.length }),
      },
      search: async (input) => {
        prefix = input.promptPrefix;
        return {
          value: {
            answer: "温度補正は入っています。",
            citations: [{ kind: "github_file", repo: "org/minutes", path: "2026/x.md" }],
            notFound: false,
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("answered");
    expect(prefix).toBe("## 候補(System One・確信度: 高)");
    expect(calls).toEqual([
      { prepare: res.queryId, q: req.question, synced: 1 },
      { cited: res.queryId, n: 1 },
    ]);
  });

  it("ADR-0041: 候補ブロックが null(low・shadow)なら promptPrefix を渡さない", async () => {
    const inputs: Record<string, unknown>[] = [];
    const { deps } = makeDeps({
      systemOne: { mode: "shadow", prepare: async () => null, recordCited: () => {} },
      search: async (input) => {
        inputs.push({ ...input });
        return {
          value: { answer: "ok", citations: [], notFound: true },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    await handleAskRequest(req, deps);
    expect("promptPrefix" in (inputs[0] ?? {})).toBe(false);
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

  it("回答ありで全 citation が破棄されたら logWarn で観測できる(notFound 時は出さない)", async () => {
    const warns: string[] = [];
    const { deps } = makeDeps({
      search: async () => ({
        value: {
          answer: "それらしい回答",
          citations: [{ kind: "github_file", repo: "evil/repo", path: "x.md" }],
          notFound: false,
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      logWarn: (_data, msg) => warns.push(msg),
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("unanswered");
    expect(warns).toHaveLength(1);

    const warnsNotFound: string[] = [];
    const { deps: deps2 } = makeDeps({ logWarn: (_d, msg) => warnsNotFound.push(msg) });
    await handleAskRequest(req, deps2); // 既定 search は notFound:true(citations 空)
    expect(warnsNotFound).toHaveLength(0);

    // notFound:true + citations 非空(スキーマ上あり得る): valid=[] は「検証全滅」ではなく
    // 「notFound なので検証スキップ」— 誤警報を出さないことが !value.notFound ガードの本質。
    const warnsSkipped: string[] = [];
    const { deps: deps3 } = makeDeps({
      search: async () => ({
        value: {
          answer: "根拠なし",
          citations: [{ kind: "github_file", repo: "evil/repo", path: "x.md" }],
          notFound: true,
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      logWarn: (_d, msg) => warnsSkipped.push(msg),
    });
    await handleAskRequest(req, deps3);
    expect(warnsSkipped).toHaveLength(0);
  });

  it("工程別の時間と検索の観測値を AskResult.metrics で返す(ADR-0035 D4・段階 1-1)", async () => {
    let t = 0;
    const { deps } = makeDeps({
      search: async () => ({
        value: {
          answer: "温度補正は入っています。",
          citations: [{ kind: "github_file", repo: "org/minutes", path: "2026/x.md" }],
          notFound: false,
        },
        usage: { inputTokens: 3, outputTokens: 4 },
        numTurns: 9,
        durationApiMs: 41_000,
        deniedToolCalls: 2,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 2000,
        totalCostUsd: 0.05,
        modelUsage: {
          m: {
            inputTokens: 3,
            outputTokens: 4,
            cacheReadInputTokens: 2000,
            cacheCreationInputTokens: 100,
            costUsd: 0.05,
          },
        },
        requestedModel: "m",
        actualModel: "m",
        startupMs: 1500,
        prewarmed: true,
        toolCalls: { Grep: 2, Read: 3, StructuredOutput: 1 },
        parallelTurns: 1,
        firstTurnCacheRead: 7000,
      }),
      // 呼ばれるたびに 1 秒進む(開始 → sync → prompt → search → recordQuery 直前 → validate)。
      monotonicMs: () => (t += 1000),
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("answered");
    expect(res.metrics).toEqual({
      syncMs: 1000,
      promptMs: 1000,
      searchMs: 1000,
      validateMs: 2000,
      elapsedMs: 4000,
      sync: null, // 従来の一括同期(perRepo 未指定)では件数を持たない
      discordSearch: null,
      failure: null,
      search: {
        numTurns: 9,
        durationApiMs: 41_000,
        deniedToolCalls: 2, // ADR-0037: 拒否数も観測する
        notFound: false,
        citations: 1,
        validCitations: 1,
        requestedModel: "m",
        actualModel: "m",
        startupMs: 1500,
        prewarmed: true, // ADR-0042: 事前起動した subprocess を使ったか
        toolCalls: { Grep: 2, Read: 3, StructuredOutput: 1 },
        parallelTurns: 1,
        firstTurnCacheRead: 7000,
        firstTurnCacheCreation: null, // 無い値は null(0 と区別する)
      },
      // 試行ごとの通知をしない差し替えの検索は最終結果の値(試行回数は不明 = null)。
      usage: {
        searchAttempts: null,
        inputTokens: 3,
        outputTokens: 4,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 2000,
        totalCostUsd: 0.05,
        modelUsage: {
          m: {
            inputTokens: 3,
            outputTokens: 4,
            cacheReadInputTokens: 2000,
            cacheCreationInputTokens: 100,
            costUsd: 0.05,
          },
        },
      },
    });
    // 無ければ null(欠損と 0 を区別する)。未回答でも工程の時間は揃う。
    const { deps: deps2 } = makeDeps();
    const res2 = await handleAskRequest(req, deps2);
    expect(res2.status).toBe("unanswered");
    expect(res2.metrics?.search).toMatchObject({
      numTurns: null,
      durationApiMs: null,
      deniedToolCalls: null,
      notFound: true,
      validCitations: 0,
    });
    expect(res2.metrics?.usage).toMatchObject({
      cacheReadInputTokens: null,
      totalCostUsd: null,
      modelUsage: null,
    });
    for (const k of ["syncMs", "promptMs", "searchMs", "validateMs"] as const) {
      expect(typeof res2.metrics?.[k]).toBe("number");
    }
  });

  it("使用量は全試行(再試行された形式エラーの回を含む)の合計を出し、試行回数を searchAttempts に入れる", async () => {
    const { deps } = makeDeps({
      search: async (input) => {
        // 1 回目: 形式エラーで再試行(費用は発生している)。2 回目: 成功。
        input.onAttempt?.({
          inputTokens: 5,
          outputTokens: 50,
          cacheReadInputTokens: 1000,
          totalCostUsd: 0.02,
          modelUsage: {
            m: {
              inputTokens: 5,
              outputTokens: 50,
              cacheReadInputTokens: 1000,
              cacheCreationInputTokens: 0,
              costUsd: 0.02,
            },
          },
        });
        input.onAttempt?.({
          inputTokens: 7,
          outputTokens: 70,
          cacheReadInputTokens: 3000,
          cacheCreationInputTokens: 200,
          totalCostUsd: 0.03,
          modelUsage: {
            m: {
              inputTokens: 7,
              outputTokens: 70,
              cacheReadInputTokens: 3000,
              cacheCreationInputTokens: 200,
              costUsd: 0.03,
            },
          },
        });
        return {
          value: { answer: "回答", citations: [], notFound: true },
          usage: { inputTokens: 7, outputTokens: 70 },
          totalCostUsd: 0.03,
        };
      },
    });
    const res = await handleAskRequest(req, deps);
    expect(res.metrics?.usage).toEqual({
      searchAttempts: 2,
      inputTokens: 12,
      outputTokens: 120,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 4000,
      totalCostUsd: 0.05,
      modelUsage: {
        m: {
          inputTokens: 12,
          outputTokens: 120,
          cacheReadInputTokens: 4000,
          cacheCreationInputTokens: 200,
          costUsd: 0.05,
        },
      },
    });
  });

  it("検索が最終的に失敗しても、それまでの試行の使用量を出す(result の無い試行は回数だけ数える)", async () => {
    const { deps } = makeDeps({
      search: async (input) => {
        input.onAttempt?.({ inputTokens: 1, outputTokens: 2, totalCostUsd: 0.01 });
        input.onAttempt?.(null); // タイムアウト等で result が無い
        throw new LlmError("TIMEOUT", "t");
      },
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("timeout");
    expect(res.metrics?.search).toBeNull();
    expect(res.metrics?.usage).toMatchObject({
      searchAttempts: 2,
      inputTokens: 1,
      outputTokens: 2,
      totalCostUsd: 0.01,
      cacheReadInputTokens: null,
    });
  });

  it("失敗した工程・経過・エラー種別を metrics.failure に入れる(本文は持たない)", async () => {
    const failAt = async (over: Partial<AskDeps>) => {
      let t = 0;
      const { deps } = makeDeps({ monotonicMs: () => (t += 10), ...over });
      return handleAskRequest(req, deps);
    };
    const gitDns = Object.assign(
      new Error("Command failed: git fetch --depth=1 https://github.com/org/x.git"),
      {
        cmd: "git -C /clones/x fetch --depth=1 https://github.com/org/x.git",
        stderr:
          "fatal: unable to access 'https://github.com/org/x.git/': Could not resolve host: github.com\n",
        code: 128,
      },
    );
    const sync = await failAt({
      syncer: {
        ...fakeSyncer(),
        sync: async () => {
          throw gitDns;
        },
      },
    });
    expect(sync.status).toBe("error");
    expect(sync.metrics?.failure).toEqual({
      stage: "sync",
      atMs: 10,
      errorKind: "GitError",
      errorCode: "GIT_DNS",
    });
    expect(sync.metrics?.syncMs).toBeNull();
    expect(sync.metrics?.search).toBeNull();

    const prompt = await failAt({
      promptStore: {
        read: async () => {
          throw new LlmError("PROMPT_NOT_FOUND", "x");
        },
      },
    });
    expect(prompt.metrics?.failure).toMatchObject({
      stage: "prompt",
      errorKind: "LlmError",
      errorCode: "PROMPT_NOT_FOUND",
    });
    expect(prompt.metrics?.syncMs).toBe(10);

    const search = await failAt({
      search: async () => {
        throw new LlmError("TIMEOUT", "t");
      },
    });
    expect(search.status).toBe("timeout");
    expect(search.metrics?.failure).toMatchObject({
      stage: "search",
      errorKind: "LlmError",
      errorCode: "TIMEOUT",
    });
    expect(search.metrics?.promptMs).toBe(10);
    expect(search.metrics?.searchMs).toBeNull();

    const validate = await failAt({
      search: async () => ({
        value: {
          answer: "温度補正は入っています。",
          citations: [{ kind: "github_file", repo: "org/minutes", path: "2026/x.md" }],
          notFound: false,
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      fileExists: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(validate.metrics?.failure).toMatchObject({
      stage: "validate",
      errorKind: "SystemError",
      errorCode: "EACCES",
    });
    expect(typeof validate.metrics?.searchMs).toBe("number");
    // 本文(質問・エラーの message)は計測値に入らない。
    expect(JSON.stringify(validate.metrics)).not.toContain(req.question);
    expect(JSON.stringify(sync.metrics)).not.toContain("Could not resolve");
  });

  it("onProgress は sync → search → (検索側の tool_use) の順で届き、search 入力へ透過する(ADR-0035 D5)", async () => {
    const events: string[] = [];
    const { deps } = makeDeps({
      search: async (input) => {
        input.onProgress?.({ kind: "tool_use", tool: "Grep", turn: 1 });
        return {
          value: { answer: "回答", citations: [], notFound: true },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      onProgress: (ev) => events.push(ev.kind === "tool_use" ? `tool:${ev.tool}` : ev.kind),
    });
    await handleAskRequest(req, deps);
    expect(events).toEqual(["sync", "search", "tool:Grep"]);
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
    expect(res.answerText).toBe(ERROR_MESSAGE);
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("error");
    expect(store.listPendingActions()).toHaveLength(0);
    expect(errors).toHaveLength(1); // §7.4: エラーは握りつぶさず観測フックへ
  });

  it("TIMEOUT はタイムアウトを文面で明示し timeout として記録(§6.2 失敗時挙動 / ADR-0030 D3)", async () => {
    const errors: unknown[] = [];
    const { deps, store } = makeDeps({
      search: async () => {
        throw new LlmError("TIMEOUT", "Agent SDK query が 120000ms でタイムアウトしました");
      },
      logError: (e) => errors.push(e),
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("timeout");
    expect(res.answerText).toBe(timeoutMessage(DEFAULT_ASK_TIMEOUT_MS));
    expect(res.answerText).toContain("600 秒");
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("timeout");
    expect(store.listPendingActions()).toHaveLength(0); // ナレッジ欠落ではないのでキューに積まない
    expect(errors).toHaveLength(1);
  });

  it("タイムアウト文面の秒数は searchTimeoutMs(実効値)に追随する", async () => {
    const { deps } = makeDeps({
      search: async () => {
        throw new LlmError("TIMEOUT", "timeout");
      },
      searchTimeoutMs: 300_000,
    });
    const res = await handleAskRequest(req, deps);
    expect(res.answerText).toContain("300 秒");
  });

  it("TIMEOUT 以外の LlmError は従来どおり ERROR_MESSAGE + error のまま", async () => {
    const { deps, store } = makeDeps({
      search: async () => {
        throw new LlmError("API_ERROR", "api down");
      },
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("error");
    expect(res.answerText).toBe(ERROR_MESSAGE);
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("error");
  });

  it("§6.2 step5: elapsedMs を monotonic 差分で記録する(常に null ではない)", async () => {
    // monotonicMs は開始・各工程の区切り(sync / prompt / search)・recordQuery 直前の順に呼ばれる。
    const ticks = [100, 110, 120, 200, 250];
    let i = 0;
    const { deps, store } = makeDeps({ monotonicMs: () => ticks[i++] ?? 300 });
    const res = await handleAskRequest(req, deps);
    expect(store.getQuery(res.queryId)?.elapsedMs).toBe(150);
    expect(res.metrics?.elapsedMs).toBe(150); // 完了ログと queries が同じ値
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

describe("期限切れ・再起動による中断(ADR-0035 追記)", () => {
  it("recordSkippedAsk(timeout_skipped): 検索せずに記録し、混雑の文面を返す(キューには積まない)", () => {
    const store = createMemoryStore();
    const res = recordSkippedAsk(
      req,
      { store, newId: counterId(), now: () => "2026-10-01T10:00:00+09:00" },
      "timeout_skipped",
      900_000,
    );
    expect(res).toEqual({
      answerText: DEADLINE_SKIPPED_MESSAGE,
      status: "timeout_skipped",
      queryId: "id-1",
    });
    expect(store.getQuery("id-1")).toMatchObject({
      answerStatus: "timeout_skipped",
      question: req.question,
      discordUserId: "u1",
      elapsedMs: 900_000,
      answer: null,
    });
    expect(store.listPendingActions()).toHaveLength(0);
  });

  it("recordSkippedAsk(interrupted): 中断の文面。記録に失敗しても通知用の結果は返す", () => {
    const errors: unknown[] = [];
    const store = createMemoryStore();
    store.recordQuery = () => {
      throw new Error("db locked");
    };
    const res = recordSkippedAsk(
      req,
      { store, newId: counterId(), now: () => "t", logError: (e) => errors.push(e) },
      "interrupted",
    );
    expect(res.status).toBe("interrupted");
    expect(res.answerText).toBe(INTERRUPTED_MESSAGE);
    expect(errors).toHaveLength(1);
  });

  it("開始前に abort 済みなら同期も検索もせず interrupted を記録する", async () => {
    let synced = 0;
    let searched = 0;
    const ctl = new AbortController();
    ctl.abort();
    const { deps, store } = makeDeps({
      syncer: {
        ...fakeSyncer(),
        sync: async () => {
          synced += 1;
          return [];
        },
      },
      search: async () => {
        searched += 1;
        throw new Error("呼ばれない");
      },
      signal: ctl.signal,
    });
    const res = await handleAskRequest(req, deps);
    expect(res).toMatchObject({ status: "interrupted", answerText: INTERRUPTED_MESSAGE });
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("interrupted");
    expect(synced).toBe(0);
    expect(searched).toBe(0);
  });

  it("同期中に abort されたら検索に入らず interrupted", async () => {
    let searched = 0;
    const ctl = new AbortController();
    const { deps, store } = makeDeps({
      syncer: {
        ...fakeSyncer(),
        sync: async () => {
          ctl.abort(); // git sync は中断できないため、終わってから判定される
          return synced;
        },
      },
      search: async () => {
        searched += 1;
        throw new Error("呼ばれない");
      },
      signal: ctl.signal,
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("interrupted");
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("interrupted");
    expect(searched).toBe(0);
  });

  it("検索に signal を渡し、ABORTED は error ではなく interrupted(logError しない・キューに積まない)", async () => {
    const errors: unknown[] = [];
    let seen: AbortSignal | undefined;
    const ctl = new AbortController();
    const { deps, store } = makeDeps({
      search: async (input) => {
        seen = input.signal;
        ctl.abort();
        throw new LlmError("ABORTED", "中断");
      },
      signal: ctl.signal,
      logError: (e) => errors.push(e),
    });
    const res = await handleAskRequest(req, deps);
    expect(seen).toBe(ctl.signal);
    expect(res).toMatchObject({ status: "interrupted", answerText: INTERRUPTED_MESSAGE });
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("interrupted");
    expect(store.listPendingActions()).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("abort されなければ従来どおり(signal を渡しても結果は変わらない)", async () => {
    const ctl = new AbortController();
    const { deps } = makeDeps({ signal: ctl.signal });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("unanswered");
  });
});

// --- all_visible 有効時のリポ単位同期(ADR-0036 D5) ---
// --- リポ単位同期(ADR-0036 D5)・TTL 再利用と前回データ利用(段階 1-2) ---

describe("handleAskRequest リポ単位同期(ADR-0036 D5・段階 1-2)", () => {
  const kb: ScopedRepo = {
    repo: "org/knowledge-base",
    dir: "knowledge-base",
    syncOnAsk: true,
    managed: false,
  };
  /** 手動指定(repos.yaml の repos:)の議事録。同期失敗の規則は厳格(AskSyncError)。 */
  const minutes: ScopedRepo = {
    repo: "org/biz-minutes",
    dir: "biz-minutes",
    syncOnAsk: true,
    managed: false,
  };
  /** 列挙由来(all_visible)で sync_on_ask に当たる議事録。使えなければ今回の対象から外す。 */
  const enumMinutes: ScopedRepo = {
    repo: "org/sales-minutes",
    dir: "sales-minutes",
    syncOnAsk: true,
    managed: true,
  };
  const code: ScopedRepo = { repo: "org/app", dir: "app", syncOnAsk: false, managed: true };
  const fresh: ScopedRepo = { repo: "org/new", dir: "new", syncOnAsk: false, managed: true };
  const sr = (r: { repo: string; dir: string }, sha: string): SyncedRepo => ({
    repo: r.repo,
    absDir: `/clones/${r.dir}`,
    resolvedCommit: sha,
  });
  const TTL = 60_000;
  const MAX_STALE = 6 * 60 * 60 * 1000;

  interface Harness {
    syncer: RepoSyncer;
    /** syncEach に渡された(= fetch を試みた)リポ。 */
    syncedSpecs: string[];
    headCalls: string[];
    restored: string[];
    /** clone の実 HEAD(無ければ clone 無し)。同期成功で new-<dir> に進む。 */
    heads: Record<string, string>;
    /** 作業ツリーが汚れているリポ。 */
    dirty: Set<string>;
    /** 同期に失敗させるリポ(テスト中に変えられる)。 */
    fail: Set<string>;
    /** clone の最終 fetch 時刻(ディスク上・fetchTimeOnDisk)。無ければ null。 */
    disk: Record<string, number>;
  }
  function harness(
    opts: {
      fail?: string[];
      heads?: Record<string, string>;
      empty?: string[];
      dirty?: string[];
      disk?: Record<string, number>;
    } = {},
  ): Harness {
    const empty = opts.empty ?? [];
    const h: Harness = {
      syncedSpecs: [],
      headCalls: [],
      restored: [],
      heads: { ...opts.heads },
      dirty: new Set(opts.dirty),
      fail: new Set(opts.fail),
      disk: { ...opts.disk },
      syncer: undefined as unknown as RepoSyncer,
    };
    const state = (spec: RepoSpec) => {
      const sha = h.heads[spec.repo];
      return sha === undefined ? null : { synced: sr(spec, sha), clean: !h.dirty.has(spec.repo) };
    };
    h.syncer = {
      sync: async () => {
        throw new Error("リポ単位モードでは sync を呼ばない");
      },
      syncEach: async (specs) =>
        specs.map((spec) => {
          h.syncedSpecs.push(spec.repo);
          if (empty.includes(spec.repo)) return { status: "empty" as const, spec };
          if (h.fail.has(spec.repo)) {
            return {
              status: "failed" as const,
              spec,
              error: Object.assign(new Error(`fetch failed ${spec.repo}`), {
                cmd: `git -C /clones/${spec.dir} fetch --depth=1 https://github.com/${spec.repo}.git`,
                stderr: "fatal: unable to access: Could not resolve host: github.com",
              }),
            };
          }
          const sha = `new-${spec.dir}`;
          h.heads[spec.repo] = sha; // fetch → reset --hard → clean でクリーンな新 HEAD
          h.dirty.delete(spec.repo);
          return { status: "synced" as const, spec, synced: sr(spec, sha) };
        }),
      resolveHead: async (spec) => {
        h.headCalls.push(spec.repo);
        const sha = h.heads[spec.repo];
        return sha === undefined ? null : sr(spec, sha);
      },
      inspect: async (spec) => state(spec),
      restoreHead: async (spec) => {
        h.restored.push(spec.repo);
        h.dirty.delete(spec.repo);
        return state(spec);
      },
      fetchTimeOnDisk: async (spec) => h.disk[spec.repo] ?? null,
    };
    return h;
  }

  function perRepoDeps(
    registry: RepoRegistry,
    h: Harness,
    answer: QaAnswer,
    over: Partial<AskDeps> = {},
  ): {
    deps: AskDeps;
    store: BotStore;
    prompts: string[];
    warns: Record<string, unknown>[];
    clock: { now: number };
  } {
    const prompts: string[] = [];
    const warns: Record<string, unknown>[] = [];
    // 壁時計(TTL・許容期間・脚注の時刻)。2026-10-01T00:12:00Z = JST 10/1 09:12。
    const clock = { now: Date.parse("2026-10-01T00:12:00Z") };
    const { deps, store } = makeDeps({
      getRepos: () => registry.scope(),
      syncer: h.syncer,
      perRepo: { registry, ttlMs: TTL, maxStalenessMs: MAX_STALE, nowMs: () => clock.now },
      search: async (input) => {
        prompts.push(`${input.systemPrompt}\n${input.systemPromptDynamic ?? ""}`);
        return { value: answer, usage: { inputTokens: 1, outputTokens: 1 } };
      },
      logWarn: (data) => warns.push(data),
      ...over,
    });
    return { deps, store, prompts, warns, clock };
  }

  const citeCode: QaAnswer = {
    answer: "実装はここです。",
    citations: [{ kind: "github_file", repo: "org/app", path: "src/a.ts", lines: "L1" }],
    notFound: false,
  };
  const citeMinutes: QaAnswer = {
    answer: "議事録にあります。",
    citations: [{ kind: "github_file", repo: "org/biz-minutes", path: "2026/x.md" }],
    notFound: false,
  };
  const citeKb: QaAnswer = {
    answer: "ナレッジにあります。",
    citations: [{ kind: "github_file", repo: "org/knowledge-base", path: "k/a.md" }],
    notFound: false,
  };
  const noAnswer: QaAnswer = { answer: "x", citations: [], notFound: true };

  it("sync_on_ask のリポだけを同期し、今回同期しないリポへの引用は定期同期の SyncedRepo で検証を通す", async () => {
    const registry = createRepoRegistry([kb, minutes, code]);
    registry.recordSynced(sr(code, "periodic-sha"));
    const h = harness();
    const { deps } = perRepoDeps(registry, h, citeCode);
    const res = await handleAskRequest(req, deps);
    expect(h.syncedSpecs).toEqual(["org/knowledge-base", "org/biz-minutes"]);
    expect(h.headCalls).toEqual([]); // 定期同期の記録があれば git を叩かない
    expect(res.status).toBe("answered");
    expect(res.answerText).toContain("https://github.com/org/app/blob/periodic-sha/src/a.ts#L1");
    // 今回同期分は registry に反映される(次の /ask・定期同期と共有)。
    expect(registry.lastSynced("org/biz-minutes")?.resolvedCommit).toBe("new-biz-minutes");
    expect(res.metrics?.sync).toEqual({
      reposInScope: 3,
      reposAvailable: 3,
      reposFetched: 2,
      reposReused: 0,
      reposSkippedReset: 0,
      reposStale: 0,
      reposExcluded: 0,
      staleAgeMs: null,
    });
  });

  it("定期同期の記録が無いリポは rev-parse HEAD(resolveHead)で解決して引用を通す", async () => {
    const registry = createRepoRegistry([kb, code]);
    const h = harness({ heads: { "org/app": "head-sha" } });
    const { deps } = perRepoDeps(registry, h, citeCode);
    const res = await handleAskRequest(req, deps);
    expect(h.headCalls).toEqual(["org/app"]);
    expect(res.status).toBe("answered");
    expect(res.answerText).toContain("/org/app/blob/head-sha/src/a.ts");
    expect(registry.lastSynced("org/app")?.resolvedCommit).toBe("head-sha");
  });

  it("clone の無いリポ(初回 clone 前)は manifest に載せず、その引用は破棄する", async () => {
    const registry = createRepoRegistry([kb, code, fresh]);
    registry.recordSynced(sr(code, "periodic-sha"));
    const h = harness(); // org/new の resolveHead は null
    const { deps, prompts } = perRepoDeps(registry, h, {
      answer: "新リポにあります。",
      citations: [{ kind: "github_file", repo: "org/new", path: "README.md" }],
      notFound: false,
    });
    const res = await handleAskRequest(req, deps);
    expect(prompts[0]).toContain("org/app → サブディレクトリ `app/`");
    expect(prompts[0]).not.toContain("org/new");
    expect(res.status).toBe("unanswered");
  });

  it("空リポ(commit 無し)は warn せず manifest・allowlist から外す。定期同期で空と分かったリポは git を叩かない", async () => {
    const emptyMin: ScopedRepo = enumMinutes;
    const emptyCode: ScopedRepo = {
      ...code,
      repo: "org/sales-management",
      dir: "sales-management",
    };
    const registry = createRepoRegistry([kb, emptyMin, emptyCode]);
    registry.recordEmpty("org/sales-management"); // 定期同期の結果
    const h = harness({ empty: ["org/sales-minutes"] });
    const { deps, prompts, warns } = perRepoDeps(registry, h, {
      answer: "x",
      citations: [{ kind: "github_file", repo: "org/sales-minutes", path: "README.md" }],
      notFound: false,
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("unanswered"); // 空リポへの引用は allowlist 外
    // リポ単位の同期失敗 warn は出さない(出るのは「全 citation が破棄」の診断 warn のみ)。
    expect(warns.some((w) => w.repo !== undefined)).toBe(false);
    expect(h.headCalls).toEqual([]);
    expect(prompts[0]).not.toContain("org/sales-minutes");
    expect(prompts[0]).not.toContain("org/sales-management");
    expect(registry.isEmpty("org/sales-minutes")).toBe(true);
  });

  it("manifest には検索範囲(ScopedRepo)の description がそのまま載る(ADR-0036 D6)", async () => {
    const described: ScopedRepo = { ...code, description: "勤怠管理システムの実装" };
    const registry = createRepoRegistry([kb, described]);
    registry.recordSynced(sr(code, "periodic-sha"));
    const { deps, prompts } = perRepoDeps(registry, harness(), noAnswer);
    await handleAskRequest(req, deps);
    expect(prompts[0]).toContain("org/app → サブディレクトリ `app/` — 勤怠管理システムの実装");
  });

  it("検索範囲は /ask のたびに getter で読む(定期同期での差し替えが次の /ask に効く)", async () => {
    const registry = createRepoRegistry([kb]);
    const h = harness({ heads: { "org/app": "h1" } });
    const { deps, prompts } = perRepoDeps(registry, h, noAnswer);
    await handleAskRequest(req, deps);
    registry.setScope([kb, code]);
    await handleAskRequest(req, deps);
    expect(prompts[0]).not.toContain("org/app");
    expect(prompts[1]).toContain("org/app → サブディレクトリ `app/`");
  });

  describe("TTL 再利用(段階 1-2)", () => {
    it("TTL 内・クリーン・HEAD 一致なら fetch せず再利用し、引用は記録 SHA を使う", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      const h = harness();
      const { deps, clock } = perRepoDeps(registry, h, citeMinutes);
      await handleAskRequest(req, deps);
      expect(h.syncedSpecs).toEqual(["org/knowledge-base", "org/biz-minutes"]);
      clock.now += TTL - 1;
      const res = await handleAskRequest(req, deps);
      expect(h.syncedSpecs).toHaveLength(2); // 2 回目は fetch しない
      expect(res.answerText).toContain("/org/biz-minutes/blob/new-biz-minutes/2026/x.md");
      expect(res.answerText).not.toContain("※ ナレッジは");
      expect(res.metrics?.sync).toMatchObject({ reposFetched: 0, reposReused: 2 });
    });

    it("TTL を過ぎたら fetch する", async () => {
      const registry = createRepoRegistry([kb]);
      const h = harness();
      const { deps, clock } = perRepoDeps(registry, h, noAnswer);
      await handleAskRequest(req, deps);
      clock.now += TTL;
      await handleAskRequest(req, deps);
      expect(h.syncedSpecs).toEqual(["org/knowledge-base", "org/knowledge-base"]);
    });

    it("作業ツリーが汚れている・HEAD が記録 SHA と違うなら TTL 内でも fetch する", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      const h = harness();
      const { deps, clock } = perRepoDeps(registry, h, noAnswer);
      await handleAskRequest(req, deps);
      h.dirty.add("org/knowledge-base"); // 例: 鮮度確認の書き込み・他プロセスの残骸
      h.heads["org/biz-minutes"] = "moved-sha"; // 例: 別経路の同期で HEAD が動いた
      clock.now += 1000;
      const res = await handleAskRequest(req, deps);
      expect(h.syncedSpecs.slice(2)).toEqual(["org/knowledge-base", "org/biz-minutes"]);
      expect(res.metrics?.sync).toMatchObject({ reposFetched: 2, reposReused: 0 });
    });

    it("invalidate されたリポ(鮮度確認の KB 書き込み)は TTL 内・クリーンでも fetch する", async () => {
      const registry = createRepoRegistry([kb]);
      const h = harness();
      const { deps, clock } = perRepoDeps(registry, h, noAnswer);
      await handleAskRequest(req, deps);
      registry.invalidate("org/knowledge-base");
      clock.now += 1000;
      await handleAskRequest(req, deps);
      expect(h.syncedSpecs).toEqual(["org/knowledge-base", "org/knowledge-base"]);
      expect(registry.isInvalidated("org/knowledge-base")).toBe(false); // 成功同期で解除
      clock.now += 1000;
      await handleAskRequest(req, deps);
      expect(h.syncedSpecs).toHaveLength(2); // 解除後は再び TTL 再利用
    });

    it("直列キューで同時に来た /ask は、先頭だけが fetch し後続は再利用する", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      const h = harness();
      const { deps, store } = perRepoDeps(registry, h, citeMinutes);
      const q = new SerialQueue();
      const results = await Promise.all([
        q.enqueue(() => handleAskRequest(req, deps)),
        q.enqueue(() => handleAskRequest(req, deps)),
        q.enqueue(() => handleAskRequest(req, deps)),
      ]);
      expect(results.map((r) => r.status)).toEqual(["answered", "answered", "answered"]);
      expect(h.syncedSpecs).toEqual(["org/knowledge-base", "org/biz-minutes"]);
      expect(results.map((r) => r.metrics?.sync?.reposReused)).toEqual([0, 2, 2]);
      expect(store.listQueries()).toHaveLength(3);
    });

    it("TTL 内の確認(inspect)はリポごとに並列に行う(ADR-0035 追記 2026-10-08)", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      const h = harness();
      const { deps, clock } = perRepoDeps(registry, h, noAnswer);
      await handleAskRequest(req, deps);
      const inspect = h.syncer.inspect;
      let active = 0;
      let maxActive = 0;
      h.syncer.inspect = async (spec) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return inspect(spec);
      };
      clock.now += 1000;
      const res = await handleAskRequest(req, deps);
      expect(maxActive).toBe(2);
      expect(res.metrics?.sync).toMatchObject({ reposReused: 2, reposFetched: 0 });
    });

    it("fetch したが reset/clean を省いたリポを reposSkippedReset に数える(reposFetched の内数)", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      const h = harness();
      const syncEach = h.syncer.syncEach;
      h.syncer.syncEach = async (specs) =>
        (await syncEach(specs)).map((r) =>
          r.status === "synced" && r.spec.repo === "org/knowledge-base"
            ? { ...r, resetSkipped: true }
            : r,
        );
      const { deps } = perRepoDeps(registry, h, noAnswer);
      const res = await handleAskRequest(req, deps);
      expect(res.metrics?.sync).toMatchObject({ reposFetched: 2, reposSkippedReset: 1 });
    });
  });

  describe("同期失敗時の前回データ利用と明確なエラー(段階 1-2)", () => {
    it("最終成功が許容期間内なら前回データ(実 HEAD)で検索し、脚注に時点(JST)を付ける", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      const h = harness();
      const { deps, clock, warns, store } = perRepoDeps(registry, h, citeMinutes);
      await handleAskRequest(req, deps); // 10/1 09:12 JST に同期成功
      h.fail.add("org/biz-minutes");
      clock.now += 2 * 60 * 60 * 1000; // 2 時間後(TTL 超え・許容期間内)
      const res = await handleAskRequest(req, deps);
      expect(res.status).toBe("answered");
      expect(res.answerText).toContain("/org/biz-minutes/blob/new-biz-minutes/2026/x.md");
      expect(res.answerText.endsWith("※ ナレッジは 10/1 09:12 時点の内容です(最新化に失敗)")).toBe(
        true,
      );
      expect(store.getQuery(res.queryId)?.answer).toContain("時点の内容です");
      expect(warns.some((w) => w.repo === "org/biz-minutes")).toBe(true);
      expect(registry.lastError("org/biz-minutes")).toContain("fetch failed");
      expect(res.metrics?.sync).toMatchObject({ reposStale: 1, staleAgeMs: 2 * 60 * 60 * 1000 });
    });

    it("未回答でも前回データで検索したことを脚注で明示する", async () => {
      const registry = createRepoRegistry([kb]);
      const h = harness();
      const { deps, clock } = perRepoDeps(registry, h, noAnswer);
      await handleAskRequest(req, deps);
      h.fail.add("org/knowledge-base");
      clock.now += TTL;
      const res = await handleAskRequest(req, deps);
      expect(res.status).toBe("unanswered");
      expect(res.answerText).toBe(
        `${NOT_FOUND_MESSAGE}\n\n※ ナレッジは 10/1 09:12 時点の内容です(最新化に失敗)`,
      );
    });

    it("前回データの作業ツリーが汚れていれば HEAD に戻してから検索する(引用 SHA と内容を一致させる)", async () => {
      const registry = createRepoRegistry([kb]);
      const h = harness();
      const { deps, clock } = perRepoDeps(registry, h, citeKb);
      await handleAskRequest(req, deps);
      h.dirty.add("org/knowledge-base");
      h.fail.add("org/knowledge-base");
      clock.now += TTL;
      const res = await handleAskRequest(req, deps);
      expect(h.restored).toEqual(["org/knowledge-base"]);
      expect(res.status).toBe("answered");
      expect(res.answerText).toContain("/org/knowledge-base/blob/new-knowledge-base/k/a.md");
    });

    it("KB も同じ規則: 許容期間を超えたら専用の文面でエラー(failedStage: sync)", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      const h = harness();
      const { deps, clock, store } = perRepoDeps(registry, h, citeKb);
      await handleAskRequest(req, deps);
      h.fail.add("org/knowledge-base");
      clock.now += MAX_STALE + 1;
      let searched = 0;
      const res = await handleAskRequest(req, {
        ...deps,
        search: async () => {
          searched += 1;
          return { value: citeKb, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      });
      expect(searched).toBe(0); // 古さの分からないデータで答えない
      expect(res.status).toBe("error");
      expect(res.answerText).toBe(syncFailedMessage(["org/knowledge-base"]));
      expect(res.answerText).not.toBe(ERROR_MESSAGE);
      expect(store.getQuery(res.queryId)?.answerStatus).toBe("error");
      expect(res.metrics?.failure).toMatchObject({
        stage: "sync",
        errorKind: "AskSyncError",
        errorCode: "GIT_DNS",
      });
    });

    it("初回同期の失敗(未同期)は clone があっても専用の文面でエラーにする", async () => {
      const registry = createRepoRegistry([kb, minutes]);
      // clone は残っている(再起動直後など)が、このプロセスでは一度も同期に成功していない。
      const h = harness({ fail: ["org/biz-minutes"], heads: { "org/biz-minutes": "old-sha" } });
      const { deps } = perRepoDeps(registry, h, citeMinutes);
      const res = await handleAskRequest(req, deps);
      expect(res.status).toBe("error");
      expect(res.answerText).toBe(syncFailedMessage(["org/biz-minutes"]));
      expect(res.answerText).toContain("org/biz-minutes");
      expect(res.metrics?.failure?.stage).toBe("sync");
    });
  });

  describe("列挙由来のリポは使えなければ対象から外す(手動指定は厳格なまま)", () => {
    it("列挙由来のリポの初回同期失敗は /ask を止めず、manifest・引用の許可リストから外す", async () => {
      const registry = createRepoRegistry([kb, enumMinutes]);
      const h = harness({ fail: ["org/sales-minutes"], heads: { "org/sales-minutes": "old" } });
      const { deps, prompts, warns } = perRepoDeps(registry, h, {
        answer: "営業議事録と KB にあります。",
        citations: [
          { kind: "github_file", repo: "org/sales-minutes", path: "2026/x.md" },
          { kind: "github_file", repo: "org/knowledge-base", path: "k/a.md" },
        ],
        notFound: false,
      });
      const res = await handleAskRequest(req, deps);
      expect(res.status).toBe("answered");
      expect(prompts[0]).not.toContain("org/sales-minutes");
      expect(res.answerText).not.toContain("org/sales-minutes"); // 対象外リポへの引用は破棄
      expect(res.answerText).toContain("/org/knowledge-base/blob/new-knowledge-base/k/a.md");
      expect(res.answerText).not.toContain("※ ナレッジは"); // 前回データは使っていない
      expect(warns).toContainEqual(
        expect.objectContaining({ repo: "org/sales-minutes", reason: "never_synced" }),
      );
      expect(res.metrics?.sync).toMatchObject({ reposExcluded: 1, reposAvailable: 1 });
      expect(res.metrics?.failure).toBeNull();
    });

    it("列挙由来のリポが許容期間を超えたら外す。許容期間内なら前回データで検索する", async () => {
      const registry = createRepoRegistry([kb, enumMinutes]);
      const h = harness();
      const { deps, clock, warns } = perRepoDeps(registry, h, noAnswer);
      await handleAskRequest(req, deps);
      h.fail.add("org/sales-minutes");
      clock.now += TTL;
      const within = await handleAskRequest(req, deps);
      expect(within.metrics?.sync).toMatchObject({ reposStale: 1, reposExcluded: 0 });
      clock.now += MAX_STALE;
      const beyond = await handleAskRequest(req, deps);
      expect(beyond.status).toBe("unanswered");
      expect(beyond.metrics?.sync).toMatchObject({ reposStale: 0, reposExcluded: 1 });
      expect(warns).toContainEqual(
        expect.objectContaining({ repo: "org/sales-minutes", reason: "too_stale" }),
      );
    });

    it("同じ /ask で手動指定のリポも使えなければ、従来どおり専用の文面でエラー(列挙分は数えるだけ)", async () => {
      const registry = createRepoRegistry([kb, minutes, enumMinutes]);
      const h = harness({ fail: ["org/biz-minutes", "org/sales-minutes"] });
      const { deps } = perRepoDeps(registry, h, noAnswer);
      const res = await handleAskRequest(req, deps);
      expect(res.status).toBe("error");
      expect(res.answerText).toBe(syncFailedMessage(["org/biz-minutes"]));
    });
  });

  describe("再起動直後の最終成功時刻(clone の FETCH_HEAD から補う)", () => {
    it("プロセス内の記録が無くても、ディスク上の最終 fetch が許容期間内なら前回データで検索する", async () => {
      const registry = createRepoRegistry([kb]);
      const fetchedAt = Date.parse("2026-09-30T23:00:00Z"); // JST 10/1 08:00(1 時間 12 分前)
      const h = harness({
        fail: ["org/knowledge-base"],
        heads: { "org/knowledge-base": "disk-sha" },
        disk: { "org/knowledge-base": fetchedAt },
      });
      const { deps } = perRepoDeps(registry, h, citeKb);
      const res = await handleAskRequest(req, deps);
      expect(res.status).toBe("answered");
      expect(res.answerText).toContain("/org/knowledge-base/blob/disk-sha/k/a.md");
      expect(res.answerText).toContain("※ ナレッジは 10/1 08:00 時点の内容です(最新化に失敗)");
    });

    it("ディスク上の時刻も許容期間を超えている・読めないなら、手動指定は専用の文面でエラー", async () => {
      const registry = createRepoRegistry([kb]);
      const now = Date.parse("2026-10-01T00:12:00Z");
      const old = harness({
        fail: ["org/knowledge-base"],
        heads: { "org/knowledge-base": "disk-sha" },
        disk: { "org/knowledge-base": now - MAX_STALE - 1 },
      });
      const r1 = await handleAskRequest(req, perRepoDeps(registry, old, citeKb).deps);
      expect(r1.answerText).toBe(syncFailedMessage(["org/knowledge-base"]));
      const none = harness({
        fail: ["org/knowledge-base"],
        heads: { "org/knowledge-base": "disk-sha" },
      });
      const r2 = await handleAskRequest(req, perRepoDeps(registry, none, citeKb).deps);
      expect(r2.answerText).toBe(syncFailedMessage(["org/knowledge-base"]));
    });

    it("プロセス内の記録があればディスクの時刻は使わない", async () => {
      const registry = createRepoRegistry([kb]);
      const h = harness({ disk: { "org/knowledge-base": 0 } }); // 使われれば許容期間超え
      const { deps, clock } = perRepoDeps(registry, h, noAnswer);
      await handleAskRequest(req, deps);
      h.fail.add("org/knowledge-base");
      clock.now += TTL;
      const res = await handleAskRequest(req, deps);
      expect(res.status).toBe("unanswered");
      expect(res.metrics?.sync).toMatchObject({ reposStale: 1 });
    });
  });
});

describe("退化回答の検出(2026-10-01「test」回答の不具合対策)", () => {
  const cite = [{ kind: "github_file" as const, repo: "org/minutes", path: "a.md" }];

  it("仮の値・タグの漏れ・短すぎる回答を理由付きで検出する", () => {
    expect(degenerateAnswerReason("test", false)).toBe("placeholder");
    expect(degenerateAnswerReason(" テスト ", false)).toBe("placeholder");
    expect(degenerateAnswerReason("Placeholder.", false)).toBe("placeholder");
    expect(
      degenerateAnswerReason(
        `${"本文".repeat(30)}</answer>\n<parameter name="citations">[]`,
        false,
      ),
    ).toBe("leaked_tool_markup");
    expect(degenerateAnswerReason("短い回答です", false)).toBe("too_short");
  });

  it("まともな回答と、notFound の回答は通す", () => {
    expect(
      degenerateAnswerReason(
        "勤怠管理システムは Google SSO でログインし、打刻と工数を記録する。",
        false,
      ),
    ).toBeNull();
    expect(degenerateAnswerReason("test", true)).toBeNull();
    expect(degenerateAnswerReason("", true)).toBeNull();
  });

  it("runAgentSearch 経由でも退化回答は STRUCTURED_PARSE になる(qa-search が 1 回だけ再試行する)", async () => {
    const queryFn: AgentQueryFn = () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          structured_output: { answer: "テスト", citations: cite, notFound: false },
        };
      })();
    await expect(
      runAgentSearch(
        {
          app: "t",
          role: "standard",
          systemPrompt: "s",
          prompt: "q",
          cwd: "/tmp",
          outputSchema: qaAnswerSchema,
        },
        { queryFn },
      ),
    ).rejects.toMatchObject({ code: "STRUCTURED_PARSE" });
  });

  it("qaAnswerSchema は退化回答を不合格にし、まともな回答は合格にする", () => {
    expect(
      qaAnswerSchema.safeParse({ answer: "test", citations: cite, notFound: false }).success,
    ).toBe(false);
    expect(
      qaAnswerSchema.safeParse({
        answer: "勤怠管理システムは Google SSO でログインし、打刻と工数を記録する。",
        citations: cite,
        notFound: false,
      }).success,
    ).toBe(true);
  });

  it("SDK に渡す JSON Schema は検証追加の前と同じ形のまま(superRefine は現れない)", async () => {
    let schema: { type?: string; required?: string[]; properties?: Record<string, unknown> } = {};
    const queryFn: AgentQueryFn = ({ options }) => {
      const fmt = options.outputFormat as { schema?: typeof schema } | undefined;
      schema = fmt?.schema ?? {};
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          structured_output: { answer: "回答", citations: [], notFound: true },
        };
      })();
    };
    await runAgentSearch(
      {
        app: "t",
        role: "standard",
        systemPrompt: "s",
        prompt: "q",
        cwd: "/tmp",
        outputSchema: qaAnswerSchema,
      },
      { queryFn },
    );
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["answer", "citations", "notFound"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["answer", "citations", "notFound"]);
  });
});

describe("モデルの置き換え検出(2026-10-01)", () => {
  it("指定と違うモデルが応答したら logWarn する。一致・不明なら出さない", async () => {
    const run = async (requestedModel?: string, actualModel?: string) => {
      const warns: Array<{ data: Record<string, unknown>; msg: string }> = [];
      const { deps } = makeDeps({
        search: async () => ({
          value: { answer: "回答", citations: [], notFound: true },
          usage: { inputTokens: 1, outputTokens: 1 },
          ...(requestedModel !== undefined ? { requestedModel } : {}),
          ...(actualModel !== undefined ? { actualModel } : {}),
        }),
        logWarn: (data, msg) => warns.push({ data, msg }),
      });
      const res = await handleAskRequest(req, deps);
      return { warns, search: res.metrics?.search };
    };
    const substituted = await run("claude-sonnet-4-6", "claude-sonnet-5");
    expect(substituted.warns).toHaveLength(1);
    expect(substituted.warns[0]?.data).toEqual({
      requestedModel: "claude-sonnet-4-6",
      actualModel: "claude-sonnet-5",
    });
    // 両方とも完了ログ用の計測値に載る(段階 1-1)。
    expect(substituted.search).toMatchObject({
      requestedModel: "claude-sonnet-4-6",
      actualModel: "claude-sonnet-5",
    });
    expect((await run("claude-sonnet-5-5", "claude-sonnet-5-5")).warns).toHaveLength(0);
    expect((await run("claude-sonnet-5-5", undefined)).warns).toHaveLength(0);
  });
});
