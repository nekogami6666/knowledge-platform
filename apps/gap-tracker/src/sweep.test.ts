import type { GhClient } from "@stratum/gh-client";
import { parseEntry, type QuestionLog, serializeEntry } from "@stratum/kb-core";
import { describe, expect, it, vi } from "vitest";
import type { GapConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildSweepRequestMessage, runOpenSweep, type SweepDeps, selectFallback } from "./sweep.js";

const DAY = 86_400_000;

const config: GapConfig = {
  kb_repo: "org/knowledge-base",
  kb_dir: "knowledge-base",
  base_branch: "main",
  assignees: [
    { github: "yamada", discord: "901" },
    { github: "suzuki", discord: "902" },
  ],
  fallback_assignees: [{ github: "tanaka", discord: "911" }, { discord: "912" }],
};

function question(id: string, over: Partial<QuestionLog> = {}): QuestionLog {
  return {
    id: id as QuestionLog["id"],
    asked_by: "extractor",
    asked_at: "2026-08-01T00:00:00+09:00",
    channel: "org/minutes",
    question: "分注ロボットの耐湿仕様は?",
    bot_answer_quality: "unanswered",
    status: "open",
    ...over,
  };
}

const raw = (id: string, over: Partial<QuestionLog> = {}) =>
  serializeEntry({ frontmatter: question(id, over), body: "\n## 質問の背景\n未確定。\n" });

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

function makeDeps(
  over: Partial<SweepDeps> = {},
): SweepDeps & { posts: string[]; written: Map<string, string> } {
  const posts: string[] = [];
  const written = new Map<string, string>();
  const { gh } = makeGh();
  const deps: SweepDeps = {
    config,
    syncKb: async () => ({ absDir: "/kb", resolvedCommit: "kbsha" }),
    gh,
    validate: async () => ({ ok: true, problems: [] }),
    listOpenQuestionFiles: async () => [
      { path: "questions/open/q-2026-t00001-entry.md", raw: raw("q-2026-t00001") },
    ],
    readFile: async (p) => {
      throw new Error(`ENOENT ${p}`); // expertise.yaml 無し(ラウンドロビンのみ)
    },
    writeFile: async (p, c) => {
      written.set(p, c);
    },
    postRequest: async (c) => void posts.push(c),
    reserveAssignee: () => true,
    discordForGithub: (g) => (g === "yamada" ? "901" : undefined),
    now: () => new Date(DAY * 20000), // 偶数日 → rr 起点 0
    logger: createLogger([], () => {}),
    real: true,
    ...over,
  };
  return Object.assign(deps, { posts, written });
}

describe("selectFallback", () => {
  it("日替わりローテーションで交代する(run.ts の rr と同じ日数基準)", () => {
    const fallbacks = config.fallback_assignees;
    const a = selectFallback(fallbacks, new Date(DAY * 20000), () => true);
    const b = selectFallback(fallbacks, new Date(DAY * 20001), () => true);
    expect(a?.discord).toBe("911");
    expect(b?.discord).toBe("912");
  });
  it("当日の起点が週上限なら翌候補へ・全員上限なら null(fallback でも上限を尊重)", () => {
    const fallbacks = config.fallback_assignees;
    const second = selectFallback(fallbacks, new Date(DAY * 20000), (d) => d !== "911");
    expect(second?.discord).toBe("912");
    expect(selectFallback(fallbacks, new Date(DAY * 20000), () => false)).toBeNull();
  });
  it("空リストは null", () => {
    expect(selectFallback([], new Date(DAY * 20000), () => true)).toBeNull();
  });
});

describe("buildSweepRequestMessage", () => {
  const assignee = { github: "yamada", discord: "901" };
  it("機械起票(asked_by: extractor)は議事録由来の文面 + q-ID", () => {
    const m = buildSweepRequestMessage(assignee, question("q-2026-t00001"), () => undefined);
    expect(m).toContain("<@901>");
    expect(m).toContain("議事録から未解決の問いとして抽出されました");
    expect(m).toContain("分注ロボットの耐湿仕様は?");
    expect(m).toContain("(q-2026-t00001)");
  });
  it("人間起票は既存テンプレ(質問者メンションを解決)", () => {
    const m = buildSweepRequestMessage(
      assignee,
      question("q-2026-t00001", { asked_by: "discord:111" }),
      () => undefined,
    );
    expect(m).toContain("<@111> さんが");
    expect(m).toContain("探していました");
  });
});

describe("runOpenSweep", () => {
  it("open + assignee 無し → 依頼送信 + status:asked を実パスへ 1 コミット(ADR-0027 D3)", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({ gh });
    const r = await runOpenSweep(deps);
    expect(r).toMatchObject({ assigned: 1, fallbackAssigned: 0, unassigned: 0, dryRun: false });
    expect(commits).toHaveLength(1);
    const commit = commits[0] as { files: { path: string; content: string }[]; branch: string };
    expect(commit.branch).toBe("main");
    // extractor 起票の <id>-<slug>.md でも実ファイル名を保って更新する。
    expect(commit.files[0]?.path).toBe("questions/open/q-2026-t00001-entry.md");
    const back = parseEntry(commit.files[0]?.content ?? "", "question");
    expect(back.frontmatter.status).toBe("asked");
    expect(back.frontmatter.assignee).toBe("yamada"); // rr 起点 0 → yamada
    expect(deps.posts).toHaveLength(1);
    expect(deps.posts[0]).toContain("議事録から未解決の問いとして抽出されました");
    expect(deps.written.has("/kb/questions/open/q-2026-t00001-entry.md")).toBe(true); // staging
  });

  it("assignees 全員が週上限 → fallback_assignees へ日替わりで依頼", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({
      gh,
      // 主プール(901/902)は週上限・fallback(911/912)は空きあり。
      reserveAssignee: (d) => d !== "901" && d !== "902",
    });
    const r = await runOpenSweep(deps);
    expect(r).toMatchObject({ assigned: 1, fallbackAssigned: 1 });
    const commit = commits[0] as { files: { content: string }[] };
    const back = parseEntry(commit.files[0]?.content ?? "", "question");
    expect(back.frontmatter.assignee).toBe("tanaka"); // 偶数日 → fallback 起点 0
    expect(deps.posts[0]).toContain("<@911>");
  });

  it("github 名を持たない fallback は discord:<id> 規約で記録する(ADR-0022)", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({
      gh,
      reserveAssignee: (d) => d === "912", // fallback 2 人目だけ空き
    });
    const r = await runOpenSweep(deps);
    expect(r.fallbackAssigned).toBe(1);
    const commit = commits[0] as { files: { content: string }[] };
    const back = parseEntry(commit.files[0]?.content ?? "", "question");
    expect(back.frontmatter.assignee).toBe("discord:912");
  });

  it("fallback も空(または全員上限)→ open のまま warn(従来挙動)", async () => {
    const logs: string[] = [];
    const { gh, commits } = makeGh();
    const deps = makeDeps({
      gh,
      config: { ...config, fallback_assignees: [] },
      reserveAssignee: () => false,
      logger: createLogger([], (l) => logs.push(l)),
    });
    const r = await runOpenSweep(deps);
    expect(r).toMatchObject({ assigned: 0, unassigned: 1 });
    expect(commits).toHaveLength(0);
    expect(deps.posts).toHaveLength(0);
    expect(logs.some((l) => l.includes("open のまま残します"))).toBe(true);
  });

  it("asked 済み・assignee 付きは対象外(二重依頼防止は status で足りる)", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({
      gh,
      listOpenQuestionFiles: async () => [
        {
          path: "questions/open/q-2026-t00001.md",
          raw: raw("q-2026-t00001", { status: "asked", assignee: "yamada" }),
        },
        {
          path: "questions/open/q-2026-t00002.md",
          raw: raw("q-2026-t00002", { assignee: "suzuki" }), // open だが担当付き(手動割当)
        },
      ],
    });
    const r = await runOpenSweep(deps);
    expect(r).toMatchObject({ assigned: 0, unassigned: 0 });
    expect(commits).toHaveLength(0);
    expect(deps.posts).toHaveLength(0);
  });

  it("dry-run は commit も依頼もしない(staging と検証まで)", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({ gh, real: false });
    const r = await runOpenSweep(deps);
    expect(r).toMatchObject({ assigned: 1, dryRun: true });
    expect(commits).toHaveLength(0);
    expect(deps.posts).toHaveLength(0);
    expect(deps.written.size).toBeGreaterThan(0); // validateRepo のための staging はする
  });

  it("validateRepo 失敗 → commit も依頼もしない", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({ gh, validate: async () => ({ ok: false, problems: [{}] }) });
    const r = await runOpenSweep(deps);
    expect(r.assigned).toBe(0);
    expect(commits).toHaveLength(0);
    expect(deps.posts).toHaveLength(0);
  });

  it("parse 不能ファイルは warn してスキップし他は処理する", async () => {
    const { gh, commits } = makeGh();
    const deps = makeDeps({
      gh,
      listOpenQuestionFiles: async () => [
        { path: "questions/open/broken.md", raw: "not frontmatter" },
        { path: "questions/open/q-2026-t00001-entry.md", raw: raw("q-2026-t00001") },
      ],
    });
    const r = await runOpenSweep(deps);
    expect(r).toMatchObject({ assigned: 1, skipped: 1 });
    expect(commits).toHaveLength(1);
  });
});
