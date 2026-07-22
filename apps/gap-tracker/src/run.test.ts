import { createMemoryStore } from "@stratum/discord-bot/store";
import type { GhClient } from "@stratum/gh-client";
import { describe, expect, it, vi } from "vitest";
import type { GapConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { type RunDeps, runGapTracker } from "./run.js";

const config: GapConfig = {
  kb_repo: "org/knowledge-base",
  kb_dir: "knowledge-base",
  base_branch: "main",
  assignees: [
    { github: "yamada", discord: "901" },
    { github: "suzuki", discord: "902" },
  ],
};

function seedStore(n: number) {
  const store = createMemoryStore();
  for (let i = 1; i <= n; i += 1) {
    store.recordQuery({
      id: `uuid-${i}`,
      correlationId: `c${i}`,
      discordUserId: "111",
      discordChannelId: "222",
      threadId: null,
      question: `質問その${i}`,
      answer: null,
      sourcesJson: null,
      answerStatus: "unanswered",
      feedback: null,
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      createdAt: "2026-07-06T10:00:00+09:00",
    });
    store.queueAction({
      id: `act-${i}`,
      type: "question_queue",
      queryId: `uuid-${i}`,
      payloadJson: null,
      state: "pending",
      createdAt: "t",
    });
  }
  return store;
}

function makeGh(): { gh: GhClient; commits: unknown[] } {
  const commits: unknown[] = [];
  const gh = {
    commitFiles: vi.fn(async (opts: unknown) => {
      commits.push(opts);
      return { sha: "NEWSHA" };
    }),
  } as unknown as GhClient;
  return { gh, commits };
}

function makeDeps(over: Partial<RunDeps> = {}): RunDeps & { written: Map<string, string> } {
  const written = new Map<string, string>();
  const store = seedStore(2);
  const { gh } = makeGh();
  const deps: RunDeps = {
    config,
    store,
    syncKb: async () => ({ absDir: "/kb", resolvedCommit: "kbsha" }),
    gh,
    // メモリ CAS ストア(kb-core のローカル実装はファイル前提なのでテストは自前 fake)。
    makeIdStore: () => {
      let counters: Record<string, Record<string, number>> = { q: { "2026": 89 } };
      let version = "v0";
      let n = 0;
      return {
        load: async () => ({ counters: structuredClone(counters), version }),
        save: async (c, expected) => {
          if (expected !== version) throw new Error("conflict");
          counters = structuredClone(c) as typeof counters;
          n += 1;
          version = `v${n}`;
        },
      };
    },
    validate: async () => ({ ok: true, problems: [] }),
    listQuestionRaws: async () => [],
    readFile: async (p) => {
      if (p.endsWith("id-counter.json")) return JSON.stringify({ q: { "2026": 91 } });
      throw new Error(`ENOENT ${p}`);
    },
    writeFile: async (p, c) => {
      written.set(p, c);
    },
    postRequest: vi.fn(async () => {}),
    reserveAssignee: () => true,
    githubForDiscord: () => undefined,
    discordForGithub: () => undefined,
    now: () => new Date("2026-07-06T01:00:00Z"),
    logger: createLogger([], () => {}),
    real: true,
    ...over,
  };
  return Object.assign(deps, { written });
}

describe("runGapTracker", () => {
  it("happy path: 質問2件を1コミット + 依頼2件 + markActionDone(§6.5 step1-3)", async () => {
    const { gh, commits } = makeGh();
    const posts: string[] = [];
    const deps = makeDeps({ gh, postRequest: async (c) => void posts.push(c) });
    const r = await runGapTracker(deps);
    expect(r).toMatchObject({ committed: 2, requested: 2, unassigned: 0, dryRun: false });
    expect(commits).toHaveLength(1);
    const commit = commits[0] as { files: { path: string }[]; message: string; branch: string };
    expect(commit.branch).toBe("main");
    const paths = commit.files.map((f) => f.path);
    expect(paths.filter((p) => p.startsWith("questions/open/q-2026-")).length).toBe(2);
    expect(paths).toContain("_meta/id-counter.json");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain("<@901>"); // ラウンドロビン起点は日替わりだが予約可なら必ず誰かに付く
    // 消費済み: pending が残っていない
    const remaining = deps.store
      .listPendingActions("question_queue")
      .filter((a) => a.state === "pending");
    expect(remaining).toHaveLength(0);
  });

  it("dry-run は commit も依頼も markActionDone もしない(staging と検証まで)", async () => {
    const { gh, commits } = makeGh();
    const posts: string[] = [];
    const deps = makeDeps({ gh, real: false, postRequest: async (c) => void posts.push(c) });
    const r = await runGapTracker(deps);
    expect(r.dryRun).toBe(true);
    expect(r.committed).toBe(2);
    expect(commits).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(
      deps.store.listPendingActions("question_queue").filter((a) => a.state === "pending"),
    ).toHaveLength(2);
    expect(deps.written.size).toBeGreaterThan(0); // staging はする(validateRepo のため)
  });

  it("既に commit 済みの query-id はスキップして done に進める(冪等)", async () => {
    const deps = makeDeps({
      listQuestionRaws: async () => ["...\nquery-id: uuid-1\n..."],
    });
    const r = await runGapTracker(deps);
    expect(r.skipped).toBe(1);
    expect(r.committed).toBe(1); // uuid-2 のみ
  });

  it("全員が週上限なら assignee 無しで commit(依頼ゼロ・status:open)", async () => {
    const posts: string[] = [];
    const deps = makeDeps({
      reserveAssignee: () => false,
      postRequest: async (c) => void posts.push(c),
    });
    const r = await runGapTracker(deps);
    expect(r).toMatchObject({ committed: 2, requested: 0, unassigned: 2 });
    expect(posts).toHaveLength(0);
    const entry = [...deps.written.values()][0] ?? "";
    expect(entry).toContain('status: "open"');
  });

  it("validateRepo 失敗 → commit も依頼もしない", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({ gh, validate: async () => ({ ok: false, problems: [{}] }) });
    const r = await runGapTracker(deps);
    expect(r.committed).toBe(0);
    expect(commits).toHaveLength(0);
    expect(
      deps.store.listPendingActions("question_queue").filter((a) => a.state === "pending"),
    ).toHaveLength(2);
  });

  it("queries に無い orphan は done に進めてスキップ", async () => {
    const deps = makeDeps();
    deps.store.queueAction({
      id: "act-orphan",
      type: "question_queue",
      queryId: "no-such",
      payloadJson: null,
      state: "pending",
      createdAt: "t",
    });
    const r = await runGapTracker(deps);
    expect(r.skipped).toBe(1);
    expect(r.committed).toBe(2);
  });

  it("キューが空なら何もしない", async () => {
    const deps = makeDeps({ store: createMemoryStore() });
    const syncSpy = vi.fn(deps.syncKb);
    const r = await runGapTracker({ ...deps, syncKb: syncSpy });
    expect(r.committed).toBe(0);
    expect(syncSpy).not.toHaveBeenCalled(); // 空なら clone にも触らない
  });
});
