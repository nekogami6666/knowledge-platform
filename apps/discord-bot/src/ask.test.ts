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
  DEFAULT_ASK_TIMEOUT_MS,
  degenerateAnswerReason,
  ERROR_MESSAGE,
  handleAskRequest,
  MANIFEST_DESCRIPTION_MAX_CHARS,
  NOT_FOUND_MESSAGE,
  normalizeLineRange,
  type QaAnswer,
  type QaCitation,
  qaAnswerSchema,
  sanitizeRepoDescription,
  timeoutMessage,
  validateCitations,
} from "./ask.js";
import { SerialQueue } from "./concurrency.js";
import { type BotStore, createMemoryStore } from "./db.js";
import { createRepoRegistry, type RepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";
import type { RepoSyncer, SyncedRepo } from "./repos.js";

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
  return {
    sync: async () => synced,
    syncEach: async () => {
      throw new Error("従来モードでは syncEach を呼ばない");
    },
    resolveHead: async () => {
      throw new Error("従来モードでは resolveHead を呼ばない");
    },
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

  it("description が無ければ従来と同一のバイト列(eval の manifest を変えない)", () => {
    expect(
      buildRepoManifest([
        { repo: "org/minutes", dir: "minutes" },
        { repo: "org/fw", dir: "dispenser-fw", description: "   " },
      ]),
    ).toBe(
      [
        "## 検索対象リポジトリ(このコーパスでの対応)",
        "- org/minutes → サブディレクトリ `minutes/`",
        "- org/fw → サブディレクトリ `dispenser-fw/`",
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

  it("検索完了ごとに logInfo へ elapsedMs / numTurns / durationApiMs を出す(ADR-0035 D4)", async () => {
    const infos: Record<string, unknown>[] = [];
    let t = 0;
    const { deps } = makeDeps({
      search: async () => ({
        value: { answer: "回答", citations: [], notFound: true },
        usage: { inputTokens: 3, outputTokens: 4 },
        numTurns: 9,
        durationApiMs: 41_000,
        deniedToolCalls: 2,
      }),
      monotonicMs: () => (t += 1000),
      logInfo: (data) => infos.push(data),
    });
    await handleAskRequest(req, deps);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      numTurns: 9,
      durationApiMs: 41_000,
      deniedToolCalls: 2, // ADR-0037: 拒否数も観測する
      notFound: true,
    });
    expect(infos[0]?.elapsedMs).toBe(1000);
    // 無ければ null(欠損と 0 を区別する)。
    const infos2: Record<string, unknown>[] = [];
    const { deps: deps2 } = makeDeps({ logInfo: (data) => infos2.push(data) });
    await handleAskRequest(req, deps2);
    expect(infos2[0]).toMatchObject({ numTurns: null, durationApiMs: null, deniedToolCalls: null });
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

// --- all_visible 有効時のリポ単位同期(ADR-0036 D5) ---

describe("handleAskRequest リポ単位同期(ADR-0036 D5)", () => {
  const kb: ScopedRepo = {
    repo: "org/knowledge-base",
    dir: "knowledge-base",
    syncOnAsk: true,
    managed: false,
  };
  const minutes: ScopedRepo = {
    repo: "org/biz-minutes",
    dir: "biz-minutes",
    syncOnAsk: true,
    managed: true,
  };
  const code: ScopedRepo = { repo: "org/app", dir: "app", syncOnAsk: false, managed: true };
  const fresh: ScopedRepo = { repo: "org/new", dir: "new", syncOnAsk: false, managed: true };
  const sr = (r: ScopedRepo, sha: string): SyncedRepo => ({
    repo: r.repo,
    absDir: `/clones/${r.dir}`,
    resolvedCommit: sha,
  });

  interface Harness {
    syncer: RepoSyncer;
    syncedSpecs: string[];
    headCalls: string[];
  }
  /**
   * fail: 同期に失敗させる repo。heads: resolveHead の結果(無ければ null = clone 無し)。
   * empty: 空リポとして返す repo。
   */
  function harness(
    fail: string[] = [],
    heads: Record<string, string> = {},
    empty: string[] = [],
  ): Harness {
    const h: Harness = {
      syncedSpecs: [],
      headCalls: [],
      syncer: {
        sync: async () => {
          throw new Error("リポ単位モードでは sync を呼ばない");
        },
        syncEach: async (specs) =>
          specs.map((spec) => {
            h.syncedSpecs.push(spec.repo);
            if (empty.includes(spec.repo)) return { status: "empty" as const, spec };
            return fail.includes(spec.repo)
              ? { status: "failed" as const, spec, error: new Error(`fetch failed ${spec.repo}`) }
              : {
                  status: "synced" as const,
                  spec,
                  synced: sr(spec as ScopedRepo, `new-${spec.dir}`),
                };
          }),
        resolveHead: async (spec) => {
          h.headCalls.push(spec.repo);
          const sha = heads[spec.repo];
          return sha === undefined ? null : sr(spec as ScopedRepo, sha);
        },
      },
    };
    return h;
  }

  function perRepoDeps(
    registry: RepoRegistry,
    h: Harness,
    answer: QaAnswer,
    over: Partial<AskDeps> = {},
  ): { deps: AskDeps; store: BotStore; prompts: string[]; warns: Record<string, unknown>[] } {
    const prompts: string[] = [];
    const warns: Record<string, unknown>[] = [];
    const { deps, store } = makeDeps({
      getRepos: () => registry.scope(),
      syncer: h.syncer,
      perRepo: { registry, kbDir: "knowledge-base" },
      search: async (input) => {
        prompts.push(input.systemPrompt);
        return { value: answer, usage: { inputTokens: 1, outputTokens: 1 } };
      },
      logWarn: (data) => warns.push(data),
      ...over,
    });
    return { deps, store, prompts, warns };
  }

  const citeCode: QaAnswer = {
    answer: "実装はここです。",
    citations: [{ kind: "github_file", repo: "org/app", path: "src/a.ts", lines: "L1" }],
    notFound: false,
  };

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
  });

  it("定期同期の記録が無いリポは rev-parse HEAD(resolveHead)で解決して引用を通す", async () => {
    const registry = createRepoRegistry([kb, code]);
    const h = harness([], { "org/app": "head-sha" });
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

  it("KB 以外の同期失敗は warn して clone の現状で検索を続ける(/ask 全体は止めない)", async () => {
    const registry = createRepoRegistry([kb, minutes]);
    const h = harness(["org/biz-minutes"], { "org/biz-minutes": "old-sha" });
    const { deps, warns } = perRepoDeps(registry, h, {
      answer: "議事録にあります。",
      citations: [{ kind: "github_file", repo: "org/biz-minutes", path: "2026/x.md" }],
      notFound: false,
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("answered");
    expect(res.answerText).toContain("/org/biz-minutes/blob/old-sha/2026/x.md");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.repo).toBe("org/biz-minutes");
    expect(registry.lastError("org/biz-minutes")).toContain("fetch failed");
  });

  it("同期に失敗し clone も無いリポは今回の対象から外す", async () => {
    const registry = createRepoRegistry([kb, minutes]);
    const h = harness(["org/biz-minutes"]);
    const { deps, prompts } = perRepoDeps(registry, h, {
      answer: "x",
      citations: [],
      notFound: true,
    });
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("unanswered");
    expect(prompts[0]).not.toContain("org/biz-minutes");
    expect(prompts[0]).toContain("org/knowledge-base");
  });

  it("空リポ(commit 無し)は warn せず manifest・allowlist から外す。定期同期で空と分かったリポは git を叩かない", async () => {
    const emptyMin: ScopedRepo = { ...minutes, repo: "org/sales-minutes", dir: "sales-minutes" };
    const emptyCode: ScopedRepo = {
      ...code,
      repo: "org/sales-management",
      dir: "sales-management",
    };
    const registry = createRepoRegistry([kb, emptyMin, emptyCode]);
    registry.recordEmpty("org/sales-management"); // 定期同期の結果
    const h = harness([], {}, ["org/sales-minutes"]);
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
    const { deps, prompts } = perRepoDeps(registry, harness(), {
      answer: "x",
      citations: [],
      notFound: true,
    });
    await handleAskRequest(req, deps);
    expect(prompts[0]).toContain("org/app → サブディレクトリ `app/` — 勤怠管理システムの実装");
  });

  it("KB の同期失敗は従来どおり /ask 全体のエラー", async () => {
    const registry = createRepoRegistry([kb, minutes]);
    const h = harness(["org/knowledge-base"], { "org/knowledge-base": "old" });
    const { deps, store } = perRepoDeps(registry, h, citeCode);
    const res = await handleAskRequest(req, deps);
    expect(res.status).toBe("error");
    expect(store.getQuery(res.queryId)?.answerStatus).toBe("error");
  });

  it("検索範囲は /ask のたびに getter で読む(定期同期での差し替えが次の /ask に効く)", async () => {
    const registry = createRepoRegistry([kb]);
    const h = harness([], { "org/app": "h1" });
    const { deps, prompts } = perRepoDeps(registry, h, {
      answer: "x",
      citations: [],
      notFound: true,
    });
    await handleAskRequest(req, deps);
    registry.setScope([kb, code]);
    await handleAskRequest(req, deps);
    expect(prompts[0]).not.toContain("org/app");
    expect(prompts[1]).toContain("org/app → サブディレクトリ `app/`");
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
      const infos: Array<Record<string, unknown>> = [];
      const { deps } = makeDeps({
        search: async () => ({
          value: { answer: "回答", citations: [], notFound: true },
          usage: { inputTokens: 1, outputTokens: 1 },
          ...(requestedModel !== undefined ? { requestedModel } : {}),
          ...(actualModel !== undefined ? { actualModel } : {}),
        }),
        logWarn: (data, msg) => warns.push({ data, msg }),
        logInfo: (data) => infos.push(data),
      });
      await handleAskRequest(req, deps);
      return { warns, infos };
    };
    const substituted = await run("claude-sonnet-4-6", "claude-sonnet-5");
    expect(substituted.warns).toHaveLength(1);
    expect(substituted.warns[0]?.data).toEqual({
      requestedModel: "claude-sonnet-4-6",
      actualModel: "claude-sonnet-5",
    });
    expect(substituted.infos[0]).toMatchObject({
      requestedModel: "claude-sonnet-4-6",
      actualModel: "claude-sonnet-5",
    });
    expect((await run("claude-sonnet-5-5", "claude-sonnet-5-5")).warns).toHaveLength(0);
    expect((await run("claude-sonnet-5-5", undefined)).warns).toHaveLength(0);
  });
});
