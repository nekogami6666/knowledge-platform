import { type BotStore, createMemoryStore } from "@stratum/discord-bot/store";
import type { GhClient, PrDetail } from "@stratum/gh-client";
import { parseEntry, type QuestionLog, serializeEntry } from "@stratum/kb-core";
import { describe, expect, it, vi } from "vitest";
import {
  askerMention,
  buildAnsweredMove,
  buildReminderMessage,
  buildWontfixReport,
  type CloseDeps,
  classifyQuestion,
  daysSince,
  resolveAskerMention,
  runFlywheelClose,
} from "./close.js";
import type { GapConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config: GapConfig = {
  kb_repo: "org/knowledge-base",
  kb_dir: "knowledge-base",
  base_branch: "main",
  assignees: [{ github: "yamada", discord: "901" }],
};

function question(id: string, over: Partial<QuestionLog> = {}): QuestionLog {
  return {
    id: id as QuestionLog["id"],
    asked_by: "discord:111",
    asked_at: "2026-07-06T10:00:00+09:00",
    channel: "222",
    question: "分注ロボットは高湿度で何が起きる?",
    bot_answer_quality: "unanswered",
    status: "asked",
    ...over,
  };
}
const openRaw = (id: string, over: Partial<QuestionLog> = {}) =>
  serializeEntry({ frontmatter: question(id, over), body: "\n## Bot の回答記録\n(未回答)\n" });

// --- 純関数 -------------------------------------------------------------------

describe("askerMention", () => {
  it("discord:<id> は <@id>、github 名は null", () => {
    expect(askerMention("discord:111")).toBe("<@111>");
    expect(askerMention("yamada")).toBeNull();
  });
});

describe("resolveAskerMention(ADR-0017 D3: github 名の asked_by も逆引きしてメンション)", () => {
  const d4g = (g: string): string | undefined => (g === "yamada" ? "901" : undefined);
  it("discord:<id> はそのまま <@id>", () => {
    expect(resolveAskerMention("discord:111", d4g)).toBe("<@111>");
  });
  it("github 名は discordForGithub で逆引きして <@id>(退行 B-1 の修正)", () => {
    expect(resolveAskerMention("yamada", d4g)).toBe("<@901>");
  });
  it("逆引き不能な github 名は null(メンション無し本文にフォールバック)", () => {
    expect(resolveAskerMention("unknown-gh", d4g)).toBeNull();
  });
});

describe("buildAnsweredMove", () => {
  it("status:answered + resulting_kb を付けて answered パスに移す", () => {
    const move = buildAnsweredMove(openRaw("q-2026-0007"), "kb-2026-0143", "q-2026-0007");
    expect(move.answeredPath).toBe("questions/answered/q-2026-0007.md");
    expect(move.openPath).toBe("questions/open/q-2026-0007.md");
    expect(move.askedBy).toBe("discord:111");
    const back = parseEntry(move.content, "question", move.answeredPath);
    expect(back.frontmatter.status).toBe("answered");
    expect(back.frontmatter.resulting_kb).toBe("kb-2026-0143");
  });
});

describe("classifyQuestion", () => {
  const base = new Date("2026-07-06T01:00:00Z"); // asked_at と同時刻
  it("asked から 7 日未満は none / 7-13 日は remind / 14 日以上は wontfix", () => {
    const asked = { status: "asked" as const, asked_at: "2026-07-06T10:00:00+09:00" };
    expect(classifyQuestion(asked, new Date(base.getTime() + 3 * 86_400_000))).toBe("none");
    expect(classifyQuestion(asked, new Date(base.getTime() + 8 * 86_400_000))).toBe("remind");
    expect(classifyQuestion(asked, new Date(base.getTime() + 15 * 86_400_000))).toBe("wontfix");
  });
  it("asked 以外(open / answered)は経過に依らず none", () => {
    const old = new Date(base.getTime() + 30 * 86_400_000);
    expect(classifyQuestion({ status: "open", asked_at: "2026-07-06T10:00:00+09:00" }, old)).toBe(
      "none",
    );
    expect(
      classifyQuestion({ status: "answered", asked_at: "2026-07-06T10:00:00+09:00" }, old),
    ).toBe("none");
  });
});

describe("daysSince", () => {
  it("経過日数を切り捨てで返す", () => {
    expect(daysSince("2026-07-06T10:00:00+09:00", new Date("2026-07-16T10:00:00+09:00"))).toBe(10);
  });
});

describe("メッセージ整形", () => {
  it("リマインドは質問と q-ID とメンションを含む", () => {
    const m = buildReminderMessage("q-2026-0007", "湿度は?", "<@901>");
    expect(m).toContain("<@901>");
    expect(m).toContain("湿度は?");
    expect(m).toContain("(q-2026-0007)");
  });
  it("wontfix レポートは各質問を列挙", () => {
    const r = buildWontfixReport([{ id: "q-2026-0007", question: "湿度は?", days: 15 }]);
    expect(r).toContain("q-2026-0007");
    expect(r).toContain("15 日経過");
  });
});

// --- オーケストレータ ---------------------------------------------------------

function makeGh(pr: Partial<PrDetail> = {}): {
  gh: GhClient;
  commits: unknown[];
  getPr: ReturnType<typeof vi.fn>;
} {
  const commits: unknown[] = [];
  const detail: PrDetail = {
    number: 42,
    state: "closed",
    merged: true,
    mergeableState: "clean",
    title: "t",
    url: "https://github.com/org/knowledge-base/pull/42",
    ...pr,
  };
  const getPr = vi.fn(async () => detail);
  const gh = {
    getPullRequest: getPr,
    commitFiles: vi.fn(async (o: unknown) => {
      commits.push(o);
      return { sha: "S" };
    }),
  } as unknown as GhClient;
  return { gh, commits, getPr };
}

function seedGapPr(store: BotStore): void {
  store.queueAction({
    id: "pr1",
    type: "gap_pr",
    queryId: null,
    payloadJson: JSON.stringify({
      prNumber: 42,
      prRepo: "org/knowledge-base",
      items: [{ questionId: "q-2026-0007", entryId: "kb-2026-0143" }],
    }),
    state: "pending",
    createdAt: "t",
  });
}

function makeDeps(
  over: Partial<CloseDeps> = {},
): CloseDeps & { store: BotStore; gapPosts: string[]; opsPosts: string[]; removed: string[] } {
  const store = over.store ?? createMemoryStore();
  if (over.store === undefined) seedGapPr(store);
  const gapPosts: string[] = [];
  const opsPosts: string[] = [];
  const removed: string[] = [];
  const { gh } = makeGh();
  const deps: CloseDeps = {
    config,
    store,
    gh,
    syncKb: async () => ({ absDir: "/kb", resolvedCommit: "s" }),
    validate: async () => ({ ok: true, problems: [] }),
    readQuestionRaw: async (_r, qid) => (qid === "q-2026-0007" ? openRaw("q-2026-0007") : null),
    listOpenQuestions: async () => [],
    writeFile: async () => {},
    removeFile: async (p) => void removed.push(p),
    discordForGithub: (g) => (g === "yamada" ? "901" : undefined),
    postGap: async (c) => void gapPosts.push(c),
    postOps: async (c) => void opsPosts.push(c),
    now: () => new Date("2026-07-20T01:00:00Z"),
    logger: createLogger([], () => {}),
    real: true,
    ...over,
  };
  return Object.assign(deps, { store, gapPosts, opsPosts, removed });
}

const pending = (s: BotStore, type: string) =>
  s.listPendingActions(type).filter((a) => a.state === "pending");

describe("runFlywheelclose (A: merged → answered 移動)", () => {
  it("merged PR → answered へ move commit(deletions)+ 質問者通知 + 台帳消費", async () => {
    const { gh, commits } = makeGh({ merged: true });
    const deps = makeDeps({ gh });
    const r = await runFlywheelClose(deps);
    expect(r.moved).toBe(1);
    expect(commits).toHaveLength(1);
    const c = commits[0] as { files: { path: string }[]; deletions: string[] };
    expect(c.files.map((f) => f.path)).toContain("questions/answered/q-2026-0007.md");
    expect(c.deletions).toContain("questions/open/q-2026-0007.md");
    expect(deps.removed).toContain("/kb/questions/open/q-2026-0007.md");
    expect(deps.gapPosts[0]).toContain("<@111>"); // asked_by=discord:111
    expect(deps.gapPosts[0]).toContain("kb-2026-0143");
    expect(pending(deps.store, "gap_pr")).toHaveLength(0);
  });

  it("asked_by が members 由来の GitHub 名でも discordForGithub 逆引きでメンションが飛ぶ(B-1 退行防止)", async () => {
    const { gh } = makeGh({ merged: true });
    const deps = makeDeps({
      gh,
      // members.yaml で解決された結果、asked_by が GitHub 名 "yamada" になったケース。
      readQuestionRaw: async (_r, qid) =>
        qid === "q-2026-0007" ? openRaw("q-2026-0007", { asked_by: "yamada" }) : null,
    });
    const r = await runFlywheelClose(deps);
    expect(r.moved).toBe(1);
    // discordForGithub("yamada") = "901" 経由でメンションが付く(旧実装は null でメンション欠落)。
    expect(deps.gapPosts[0]).toContain("<@901>");
  });

  it("未マージ(open)は move せず台帳を残す(次回持ち越し)", async () => {
    const { gh, commits } = makeGh({ merged: false, state: "open" });
    const deps = makeDeps({ gh });
    const r = await runFlywheelClose(deps);
    expect(r.moved).toBe(0);
    expect(commits).toHaveLength(0);
    expect(pending(deps.store, "gap_pr")).toHaveLength(1);
  });

  it("マージされず closed(却下)は move せず台帳を畳む", async () => {
    const { gh, commits } = makeGh({ merged: false, state: "closed" });
    const deps = makeDeps({ gh });
    const r = await runFlywheelClose(deps);
    expect(r.moved).toBe(0);
    expect(commits).toHaveLength(0);
    expect(pending(deps.store, "gap_pr")).toHaveLength(0);
  });

  it("validateRepo 失敗 → move を commit せず台帳も消費しない", async () => {
    const { gh, commits } = makeGh({ merged: true });
    const deps = makeDeps({ gh, validate: async () => ({ ok: false, problems: [{}] }) });
    const r = await runFlywheelClose(deps);
    expect(r.moved).toBe(0);
    expect(commits).toHaveLength(0);
    expect(pending(deps.store, "gap_pr")).toHaveLength(1);
  });

  it("dry-run は move も通知も台帳消費もしない", async () => {
    const { gh, commits } = makeGh({ merged: true });
    const deps = makeDeps({ gh, real: false });
    const r = await runFlywheelClose(deps);
    expect(r.moved).toBe(1); // 予定数
    expect(commits).toHaveLength(0);
    expect(deps.gapPosts).toHaveLength(0);
    expect(pending(deps.store, "gap_pr")).toHaveLength(1);
  });
});

describe("runFlywheelClose (B: リマインド / wontfix)", () => {
  const openPrGh = () => makeGh({ merged: false, state: "open" }).gh;

  it("7 日経過の asked → リマインド送信 + gap_reminder 台帳(mention 付き)", async () => {
    const store = createMemoryStore();
    const deps = makeDeps({
      store,
      gh: openPrGh(),
      now: () => new Date("2026-07-15T01:00:00Z"), // asked 2026-07-06 → 8日
      listOpenQuestions: async () => [question("q-2026-0007", { assignee: "yamada" })],
    });
    const r = await runFlywheelClose(deps);
    expect(r.remindersSent).toBe(1);
    expect(deps.gapPosts[0]).toContain("リマインド");
    expect(deps.gapPosts[0]).toContain("<@901>"); // assignee yamada → discord 901
    expect(deps.store.listPendingActions("gap_reminder")).toHaveLength(1);
  });

  it("既にリマインド済み(gap_reminder 台帳あり)は二重送信しない", async () => {
    const store = createMemoryStore();
    store.queueAction({
      id: "rem1",
      type: "gap_reminder",
      queryId: null,
      payloadJson: JSON.stringify({ questionId: "q-2026-0007" }),
      state: "done",
      createdAt: "t",
    });
    const deps = makeDeps({
      store,
      gh: openPrGh(),
      now: () => new Date("2026-07-15T01:00:00Z"),
      listOpenQuestions: async () => [question("q-2026-0007", { assignee: "yamada" })],
    });
    const r = await runFlywheelClose(deps);
    expect(r.remindersSent).toBe(0);
    expect(deps.gapPosts).toHaveLength(0);
  });

  it("14 日経過 → #stratum-ops に wontfix レポート + gap_wontfix 台帳", async () => {
    const store = createMemoryStore();
    const deps = makeDeps({
      store,
      gh: openPrGh(),
      now: () => new Date("2026-07-25T01:00:00Z"), // asked 2026-07-06 → 18日
      listOpenQuestions: async () => [question("q-2026-0007")],
    });
    const r = await runFlywheelClose(deps);
    expect(r.wontfixReported).toBe(1);
    expect(deps.opsPosts[0]).toContain("wontfix");
    expect(deps.store.listPendingActions("gap_wontfix")).toHaveLength(1);
    expect(deps.gapPosts).toHaveLength(0); // 14日超はリマインドしない
  });
});
