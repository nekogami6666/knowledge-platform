import { type BotStore, createMemoryStore } from "@stratum/discord-bot/store";
import type { GhClient } from "@stratum/gh-client";
import { type QuestionLog, serializeEntry } from "@stratum/kb-core";
import { describe, expect, it, vi } from "vitest";
import type { AnswerEntryCandidate } from "./answer.js";
import type { GapConfig } from "./config.js";
import { answersBranch, type IngestDeps, runAnswerIngestion } from "./ingest.js";
import { createLogger } from "./logger.js";

const config: GapConfig = {
  kb_repo: "org/knowledge-base",
  kb_dir: "knowledge-base",
  base_branch: "main",
  assignees: [{ github: "yamada", discord: "901" }],
};

const URL = "https://discord.com/channels/1/2/3";

function questionRaw(id: string, question: string): string {
  const fm: QuestionLog = {
    id: id as QuestionLog["id"],
    asked_by: "discord:111",
    asked_at: "2026-07-06T10:00:00+09:00",
    channel: "222",
    question,
    bot_answer_quality: "unanswered",
    status: "asked",
  };
  return serializeEntry({ frontmatter: fm, body: "\n## Bot の回答記録\n(未回答)\n" });
}

const candidate: AnswerEntryCandidate = {
  title: "高湿度と Y 軸脱調",
  entryType: "fact",
  domain: "hardware",
  body: "40%RH 以下に保つ。",
  confidence: "high",
};

function seedAnswer(store: BotStore, id: string, questionId: string): void {
  store.queueAction({
    id,
    type: "gap_answer",
    queryId: null,
    payloadJson: JSON.stringify({
      questionId,
      authorId: "901",
      content: "Y 軸が脱調します。",
      messageUrl: URL,
    }),
    state: "pending",
    createdAt: "t",
  });
}

function makeGh(): { gh: GhClient; prs: unknown[] } {
  const prs: unknown[] = [];
  const gh = {
    createPullRequest: vi.fn(async (opts: unknown) => {
      prs.push(opts);
      return { number: 42, url: "https://github.com/org/knowledge-base/pull/42" };
    }),
  } as unknown as GhClient;
  return { gh, prs };
}

function makeDeps(over: Partial<IngestDeps> = {}): IngestDeps & { written: Map<string, string> } {
  const written = new Map<string, string>();
  const store = createMemoryStore();
  seedAnswer(store, "a1", "q-2026-0007");
  const { gh } = makeGh();
  const deps: IngestDeps = {
    config,
    store,
    syncKb: async () => ({ absDir: "/kb", resolvedCommit: "kbsha" }),
    gh,
    // メモリ CAS(kb-core のローカル実装はファイル前提なのでテストは自前 fake)。
    makeIdStore: () => {
      let counters: Record<string, Record<string, number>> = { kb: { "2026": 142 } };
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
    readQuestionRaw: async (_root, qid) =>
      qid === "q-2026-0007" ? questionRaw(qid, "分注ロボットは高湿度で何が起きる?") : null,
    readFile: async (p) => {
      if (p.endsWith("id-counter.json")) return JSON.stringify({ kb: { "2026": 143 } });
      throw new Error(`ENOENT ${p}`);
    },
    writeFile: async (p, c) => {
      written.set(p, c);
    },
    listDomains: async () => ["hardware"],
    draft: async () => candidate,
    postOps: vi.fn(async () => {}),
    githubForDiscord: (id) => (id === "901" ? "yamada" : undefined),
    now: () => new Date("2026-07-06T01:00:00Z"),
    logger: createLogger([], () => {}),
    real: true,
    ...over,
  };
  return Object.assign(deps, { written });
}

const pendingAnswers = (s: BotStore) =>
  s.listPendingActions("gap_answer").filter((a) => a.state === "pending");

describe("answersBranch", () => {
  it("順序に依らず決定的(冪等ブランチ)", () => {
    expect(answersBranch(["q-2026-0002", "q-2026-0001"])).toBe(
      answersBranch(["q-2026-0001", "q-2026-0002"]),
    );
    expect(answersBranch(["q-2026-0001"])).toMatch(/^gap\/answers-[0-9a-f]{8}$/);
  });
});

describe("runAnswerIngestion", () => {
  it("回答1件 → 1 PR(entry + id-counter)+ ops 通知 + gap_pr 台帳 + 消費", async () => {
    const { gh, prs } = makeGh();
    const posts: string[] = [];
    const deps = makeDeps({ gh, postOps: async (c) => void posts.push(c) });
    const r = await runAnswerIngestion(deps);
    expect(r).toMatchObject({ drafted: 1, prCreated: 1, dryRun: false });
    expect(prs).toHaveLength(1);
    const pr = prs[0] as { repo: string; head: string; base: string; files: { path: string }[] };
    expect(pr.repo).toBe("org/knowledge-base");
    expect(pr.base).toBe("main");
    expect(pr.head).toBe(answersBranch(["q-2026-0007"]));
    const paths = pr.files.map((f) => f.path);
    expect(paths).toContain("knowledge/hardware/kb-2026-0143-entry.md");
    expect(paths).toContain("_meta/id-counter.json");
    expect(posts[0]).toContain("https://github.com/org/knowledge-base/pull/42");

    const ledger = deps.store.listPendingActions("gap_pr");
    expect(ledger).toHaveLength(1);
    expect(JSON.parse(ledger[0]?.payloadJson ?? "{}")).toMatchObject({
      prNumber: 42,
      prRepo: "org/knowledge-base",
      // asked_at は close の整合ガード(§92)用。KB 質問の asked_at がそのまま台帳へ載る。
      items: [
        {
          questionId: "q-2026-0007",
          entryId: "kb-2026-0143",
          asked_at: "2026-07-06T10:00:00+09:00",
        },
      ],
    });
    expect(pendingAnswers(deps.store)).toHaveLength(0);
  });

  it("dry-run は PR も通知も markActionDone もしない(staging + validate まで)", async () => {
    const { gh, prs } = makeGh();
    const posts: string[] = [];
    const deps = makeDeps({ gh, real: false, postOps: async (c) => void posts.push(c) });
    const r = await runAnswerIngestion(deps);
    expect(r).toMatchObject({ drafted: 1, prCreated: 0, dryRun: true });
    expect(prs).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(pendingAnswers(deps.store)).toHaveLength(1);
    expect(deps.written.size).toBeGreaterThan(0);
    expect(deps.store.listPendingActions("gap_pr")).toHaveLength(0);
  });

  it("questions/open に無い回答はスキップして消費(PR 対象にしない)", async () => {
    const { gh, prs } = makeGh();
    const deps = makeDeps({ gh, readQuestionRaw: async () => null });
    const r = await runAnswerIngestion(deps);
    expect(r).toMatchObject({ drafted: 0, skipped: 1 });
    expect(prs).toHaveLength(0);
    expect(pendingAnswers(deps.store)).toHaveLength(0);
  });

  it("payload 不正はスキップして消費", async () => {
    const store = createMemoryStore();
    store.queueAction({
      id: "bad",
      type: "gap_answer",
      queryId: null,
      payloadJson: "{not json",
      state: "pending",
      createdAt: "t",
    });
    const { gh, prs } = makeGh();
    const deps = makeDeps({ store, gh });
    const r = await runAnswerIngestion(deps);
    expect(r.skipped).toBe(1);
    expect(prs).toHaveLength(0);
    expect(pendingAnswers(store)).toHaveLength(0);
  });

  it("validateRepo 失敗 → PR を作らず消費もしない", async () => {
    const { gh, prs } = makeGh();
    const deps = makeDeps({ gh, validate: async () => ({ ok: false, problems: [{}] }) });
    const r = await runAnswerIngestion(deps);
    expect(r.prCreated).toBe(0);
    expect(prs).toHaveLength(0);
    expect(pendingAnswers(deps.store)).toHaveLength(1);
  });

  it("gap_answer が無ければ何もしない(clone に触らない)", async () => {
    const deps = makeDeps({ store: createMemoryStore() });
    const syncSpy = vi.fn(deps.syncKb);
    const r = await runAnswerIngestion({ ...deps, syncKb: syncSpy });
    expect(r.drafted).toBe(0);
    expect(syncSpy).not.toHaveBeenCalled();
  });
});
