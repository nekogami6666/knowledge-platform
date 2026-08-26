import { type GhClient, GhClientError } from "@stratum/gh-client";
import type { PromptStore } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../candidate.js";
import type { ExtractSearchFn } from "../extract.js";
import type { Logger } from "../logger.js";
import type { NotifyMessage, SkipNotice } from "../notify.js";
import type { ReconcileSearchFn } from "../reconcile.js";
import { discordSourceConfigSchema } from "./config.js";
import { type CollectorSessionLike, type DiscordRunDeps, runDiscordSource } from "./run.js";
import { DISCORD_STATE_PATH, serializeDiscordState } from "./state.js";
import type { WindowMessage } from "./window.js";

const fakePromptStore: PromptStore = {
  read: async () => "---\nrole: standard\n---\nRULES",
};

const NOW = new Date("2026-08-21T00:00:00Z");

function makeMsg(id: string, over: Partial<WindowMessage> = {}): WindowMessage {
  return {
    id,
    authorId: "500",
    authorName: "表示名",
    authorIsBot: false,
    content: `本文 ${id}`,
    createdAt: new Date("2026-08-20T10:00:00Z"),
    hasLightbulb: false,
    url: `https://discord.com/channels/100/200/${id}`,
    ...over,
  };
}

const learningExtraction: ExtractionResult = {
  decisions: [],
  learnings: [
    {
      kind: "learning",
      title: "議事録テンプレは docs 配下で管理する",
      body: "議事録テンプレを更新するときは変更履歴も追記する。",
      entryType: "procedure",
      domain: "hardware",
      people: ["宗石"],
      tags: [],
      confidence: "medium",
      slug: "minutes-template",
    },
  ],
  openQuestions: [{ kind: "open_question", title: "台帳の保管場所", body: "どこに置くか未定。" }],
};

const emptyExtraction: ExtractionResult = { decisions: [], learnings: [], openQuestions: [] };

interface Harness {
  deps: DiscordRunDeps;
  calls: {
    listPr: number;
    prs: { head: string; title: string; files: { path: string; content: string }[] }[];
    commits: { branch: string; files: { path: string; content: string }[] }[];
    notified: NotifyMessage[];
    skipped: SkipNotice[];
    fetches: { channelId: string; afterId: string | null; cap: number }[];
    sessionsOpened: number;
    sessionsClosed: number;
    writes: string[];
    warns: string[];
  };
}

function makeHarness(
  over: {
    config?: Record<string, unknown>;
    messages?: WindowMessage[];
    openPrs?: { number: number; title: string; headRef: string; url: string }[];
    extractions?: ExtractionResult[];
    extractError?: boolean;
    membersYaml?: string;
    stateRaw?: string;
    real?: boolean;
    conflictTimes?: number;
    /** listReadableTextChannels の返り値(既定: "200" のみ)。 */
    readable?: { id: string; name: string; parentId: string | null }[];
  } = {},
): Harness {
  const calls: Harness["calls"] = {
    listPr: 0,
    prs: [],
    commits: [],
    notified: [],
    skipped: [],
    fetches: [],
    sessionsOpened: 0,
    sessionsClosed: 0,
    writes: [],
    warns: [],
  };
  const config = discordSourceConfigSchema.parse({
    targets: ["200"],
    kb: { repo: "org/kb" },
    ...(over.config ?? {}),
  });
  const messages = over.messages ?? [makeMsg("1001")];
  const extractions = [...(over.extractions ?? [learningExtraction])];
  let conflictsLeft = over.conflictTimes ?? 0;
  let idSeq = 0;

  const extractSearch: ExtractSearchFn = async () => {
    if (over.extractError === true) throw new Error("LLM が落ちた");
    const value =
      extractions.length > 1 ? (extractions.shift() as ExtractionResult) : extractions[0];
    return { value: value ?? emptyExtraction, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const reconcileSearch: ReconcileSearchFn = async () => ({
    value: { classification: "new", reason: "既存に無い" },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const session: CollectorSessionLike = {
    listReadableTextChannels: () => over.readable ?? [{ id: "200", name: "dev", parentId: null }],
    fetchMessagesAfter: async (channelId, afterId, cap) => {
      calls.fetches.push({ channelId, afterId, cap });
      return messages;
    },
    close: async () => {
      calls.sessionsClosed += 1;
    },
  };
  const gh: GhClient = {
    createPullRequest: async (opts) => {
      calls.prs.push({ head: opts.head, title: opts.title, files: [...opts.files] });
      return { number: 1, url: "https://github.com/org/kb/pull/1" };
    },
    listPullRequests: async () => {
      calls.listPr += 1;
      return over.openPrs ?? [];
    },
    mergePullRequest: async () => {
      throw new Error("unexpected");
    },
    getPullRequest: async () => {
      throw new Error("unexpected");
    },
    commitFiles: async (opts) => {
      calls.commits.push({ branch: opts.branch, files: [...opts.files] });
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        throw new GhClientError("CONFLICT", "non-fast-forward");
      }
      return { sha: "abc" };
    },
    getFileContents: async () => null,
    listMergedPullRequests: async () => [],
    listPullRequestComments: async () => [],
    listPullRequestFiles: async () => [],
    listCommits: async () => [],
  };
  const logger: Logger = {
    info: () => {},
    warn: (m) => {
      calls.warns.push(m);
    },
    error: () => {},
  };
  const deps: DiscordRunDeps = {
    config,
    channelsConfig: { permanent_exclude: [] },
    openSession: async () => {
      calls.sessionsOpened += 1;
      return session;
    },
    syncKb: async () => ({ absDir: "/kb/knowledge-base", resolvedCommit: "deadbeef" }),
    gh,
    extractDeps: { promptStore: fakePromptStore, search: extractSearch },
    reconcileDeps: { promptStore: fakePromptStore, search: reconcileSearch },
    makeId: (kind) => {
      idSeq += 1;
      return `${kind}-2026-ab000${idSeq}`;
    },
    validate: async () => ({ ok: true, problems: [] }),
    readFile: async (p) => {
      if (p.endsWith("members.yaml") && over.membersYaml !== undefined) return over.membersYaml;
      if (p.endsWith("extractor-discord-state.json") && over.stateRaw !== undefined)
        return over.stateRaw;
      throw new Error("ENOENT");
    },
    writeFile: async (p) => {
      calls.writes.push(p);
    },
    readdir: async () => [],
    listFiles: async () => [],
    notifier: {
      notifyPrCreated: async (m) => {
        calls.notified.push(m);
      },
      notifySkipped: async (m) => {
        calls.skipped.push(m);
      },
    },
    now: () => NOW,
    logger,
    real: over.real ?? true,
    reconcileConcurrency: 2,
  };
  return { deps, calls };
}

describe("runDiscordSource", () => {
  it("targets が空なら disabled で即終了し、gh にもセッションにも触れない", async () => {
    const h = makeHarness({ config: { targets: [] } });
    const r = await runDiscordSource(h.deps);
    expect(r).toMatchObject({ created: false, reason: "disabled" });
    expect(h.calls.listPr).toBe(0);
    expect(h.calls.sessionsOpened).toBe(0);
  });

  it("all_visible: targets が空でも可視チャンネル全部が対象になり、exclude で本ソースだけ除外できる", async () => {
    const h = makeHarness({
      config: { targets: [], all_visible: true, exclude: ["300"], max_channels: 5 },
      readable: [
        { id: "300", name: "zatsudan", parentId: null },
        { id: "200", name: "dev", parentId: null },
        { id: "400", name: "pj", parentId: null },
      ],
      extractions: [emptyExtraction],
    });
    const r = await runDiscordSource(h.deps);
    expect(r.reason).not.toBe("disabled");
    // 200 と 400 が対象(ID 昇順ローテーション)。300 は exclude で対象外。
    expect(h.calls.fetches.map((f) => f.channelId).sort()).toEqual(["200", "400"]);
    expect(r.channelsProcessed).toBe(2);
  });

  it("all_visible でも channels.yaml の permanent_exclude は効く(bot 全体のゲート)", async () => {
    const h = makeHarness({
      config: { targets: [], all_visible: true, max_channels: 5 },
      readable: [
        { id: "200", name: "dev", parentId: null },
        { id: "400", name: "pj", parentId: null },
      ],
      extractions: [emptyExtraction],
    });
    h.deps.channelsConfig = { permanent_exclude: ["400"] };
    await runDiscordSource(h.deps);
    expect(h.calls.fetches.map((f) => f.channelId)).toEqual(["200"]);
  });

  it("open な extract-discord/* PR があれば skip し、label 付きで notifySkipped する(カーソル不動)", async () => {
    const h = makeHarness({
      config: { review_mentions: ["901"] },
      openPrs: [
        {
          number: 9,
          title: "extract-discord: 先行",
          headRef: "extract-discord/2026-08-20-0900",
          url: "https://github.com/org/kb/pull/9",
        },
      ],
    });
    const r = await runDiscordSource(h.deps);
    expect(r).toMatchObject({ created: false, reason: "already-exists" });
    expect(h.calls.skipped).toHaveLength(1);
    expect(h.calls.skipped[0]).toMatchObject({
      prUrl: "https://github.com/org/kb/pull/9",
      label: "Discord 抽出",
      reviewer: "901",
    });
    expect(h.calls.sessionsOpened).toBe(0);
    expect(h.calls.commits).toHaveLength(0);
  });

  it("nightly の extract/* PR は冪等ガードの対象外(prefix 不一致)", async () => {
    const h = makeHarness({
      openPrs: [
        { number: 8, title: "extract: 夜間", headRef: "extract/abc1234", url: "https://x/8" },
      ],
    });
    const r = await runDiscordSource(h.deps);
    expect(r.reason).not.toBe("already-exists");
    expect(h.calls.sessionsOpened).toBe(1);
  });

  it("抽出成立で PR を作成し、state は main へ直 commit する(PR に state を同梱しない)", async () => {
    const h = makeHarness({});
    const r = await runDiscordSource(h.deps);
    expect(r).toMatchObject({ created: true, reason: "created", stateCommitted: true });
    // PR: branch prefix / エントリのみ
    expect(h.calls.prs).toHaveLength(1);
    const pr = h.calls.prs[0];
    expect(pr?.head.startsWith("extract-discord/")).toBe(true);
    expect(pr?.files.some((f) => f.path.startsWith("knowledge/hardware/"))).toBe(true);
    expect(pr?.files.some((f) => f.path === DISCORD_STATE_PATH)).toBe(false);
    // state: main へ直 commit・カーソルは取得末尾(1001)
    expect(h.calls.commits).toHaveLength(1);
    const commit = h.calls.commits[0];
    expect(commit?.branch).toBe("main");
    expect(commit?.files[0]?.path).toBe(DISCORD_STATE_PATH);
    expect(commit?.files[0]?.content).toContain('"last_message_id": "1001"');
    // 通知: label + openQuestions は件数のみ
    expect(h.calls.notified).toHaveLength(1);
    expect(h.calls.notified[0]).toMatchObject({ label: "Discord 抽出" });
    expect(h.calls.notified[0]?.counts).toMatchObject({ new: 1, openQuestions: 1 });
    // セッションは LLM の前に閉じている(短命)
    expect(h.calls.sessionsClosed).toBe(1);
  });

  it("抽出ゼロ件でも state は commit する(zero-yield 常態のバックログでカーソルが前進する)", async () => {
    const h = makeHarness({ extractions: [emptyExtraction] });
    const r = await runDiscordSource(h.deps);
    expect(r).toMatchObject({ created: false, reason: "no-entries", stateCommitted: true });
    expect(h.calls.prs).toHaveLength(0);
    expect(h.calls.commits).toHaveLength(1);
  });

  it("予算切れ(max_extract_calls)のウィンドウはカーソルを進めず次回再訪する", async () => {
    // 31 分ギャップで 2 ウィンドウ・予算 1 → 2 つ目は deferred、カーソルは 1 つ目の末尾
    const h = makeHarness({
      config: { max_extract_calls: 1 },
      messages: [
        makeMsg("1001", { createdAt: new Date("2026-08-20T10:00:00Z") }),
        makeMsg("1002", { createdAt: new Date("2026-08-20T10:05:00Z") }),
        makeMsg("2001", { createdAt: new Date("2026-08-20T11:00:00Z") }),
      ],
      extractions: [emptyExtraction],
    });
    const r = await runDiscordSource(h.deps);
    expect(r.windowsExtracted).toBe(1);
    expect(r.windowsDeferred).toBe(1);
    expect(h.calls.commits[0]?.files[0]?.content).toContain('"last_message_id": "1002"');
  });

  it("max_entries_per_run に達したら以降のウィンドウは抽出せず持ち越す(カーソルは処理済み末尾まで)", async () => {
    // 3 ウィンドウ(31 分ギャップ)・各 1 エントリ・上限 1 → 1 つ目で到達、2 つ目以降は deferred
    const h = makeHarness({
      config: { max_entries_per_run: 1, max_extract_calls: 8 },
      messages: [
        makeMsg("1001", { createdAt: new Date("2026-08-20T10:00:00Z") }),
        makeMsg("2001", { createdAt: new Date("2026-08-20T11:00:00Z") }),
        makeMsg("3001", { createdAt: new Date("2026-08-20T12:00:00Z") }),
      ],
    });
    const r = await runDiscordSource(h.deps);
    expect(r.windowsExtracted).toBe(1);
    expect(r.windowsDeferred).toBe(2);
    expect(r.counts.new).toBe(1);
    expect(h.calls.commits[0]?.files[0]?.content).toContain('"last_message_id": "1001"');
  });

  it("抽出失敗のウィンドウはカーソルを進めない(先頭で失敗なら state commit 自体を行わない)", async () => {
    const h = makeHarness({ extractError: true });
    const r = await runDiscordSource(h.deps);
    expect(r).toMatchObject({ created: false, reason: "no-entries", stateCommitted: false });
    expect(r.windowsDeferred).toBe(1);
    expect(h.calls.commits).toHaveLength(0);
    expect(h.calls.warns.some((w) => w.includes("抽出に失敗"))).toBe(true);
  });

  it("dry-run は gh に一切触れない(PR も state commit もログのみ)", async () => {
    const h = makeHarness({ real: false });
    const r = await runDiscordSource(h.deps);
    expect(r).toMatchObject({ created: false, reason: "dry-run", stateCommitted: false });
    expect(h.calls.listPr).toBe(0);
    expect(h.calls.prs).toHaveLength(0);
    expect(h.calls.commits).toHaveLength(0);
    // materialize までは実行される(would-be の観測)
    expect(h.calls.writes.length).toBeGreaterThan(0);
  });

  it("state commit の CONFLICT は 1 回だけ再試行する", async () => {
    const h = makeHarness({ extractions: [emptyExtraction], conflictTimes: 1 });
    const r = await runDiscordSource(h.deps);
    expect(r.stateCommitted).toBe(true);
    expect(h.calls.commits).toHaveLength(2);
  });

  it("CONFLICT が続けば諦めて次回に任せる(stateCommitted=false)", async () => {
    const h = makeHarness({ extractions: [emptyExtraction], conflictTimes: 2 });
    const r = await runDiscordSource(h.deps);
    expect(r.stateCommitted).toBe(false);
    expect(h.calls.commits).toHaveLength(2);
  });

  it("既存カーソルがあれば after に使い、backfill は使わない", async () => {
    const state = serializeDiscordState({
      version: 1,
      channels: { "200": { last_message_id: "999", last_processed_at: "2026-08-19T00:00:00Z" } },
      last_run_at: "2026-08-19T00:00:00Z",
    });
    const h = makeHarness({ stateRaw: state, extractions: [emptyExtraction] });
    await runDiscordSource(h.deps);
    expect(h.calls.fetches[0]?.afterId).toBe("999");
  });

  it("permanent_exclude のチャンネルは対象外(no-messages)", async () => {
    const h = makeHarness({});
    h.deps.channelsConfig = { permanent_exclude: ["200"] };
    const r = await runDiscordSource(h.deps);
    expect(r).toMatchObject({ created: false, reason: "no-messages" });
  });

  it("著者を members.yaml で正規化し、LLM 出力の people にも resolver を適用する(D8)", async () => {
    const membersYaml = [
      "members:",
      "  - name: Yoshimasa Muneishi",
      '    aliases: ["宗石"]',
      "    github: muneishi",
      '    discord: "500"',
    ].join("\n");
    let capturedPrompt = "";
    const h = makeHarness({ membersYaml });
    const orig = h.deps.extractDeps.search;
    h.deps.extractDeps = {
      ...h.deps.extractDeps,
      search: async (opts, d) => {
        capturedPrompt = opts.prompt;
        return (orig as ExtractSearchFn)(opts, d);
      },
    };
    await runDiscordSource(h.deps);
    // プロンプトの著者ラベルは githubForDiscord で正規化
    expect(capturedPrompt).toContain("[muneishi]");
    // learning の people「宗石」も resolver で muneishi へ(関係者欄)
    expect(h.calls.notified[0]?.people).toEqual(["muneishi"]);
  });
});
