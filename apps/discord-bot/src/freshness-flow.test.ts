import type { GhClient } from "@stratum/gh-client";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { createMemoryStore, type PendingAction } from "./db.js";
import { FRESHNESS_ACTION_TYPE } from "./freshness.js";
import {
  applyFreshnessReaction,
  buildFreshnessDm,
  CONTRADICTION_ACTION_TYPE,
  drainFreshnessDms,
  type FreshnessApplyDeps,
  freshnessReactionDecision,
  parseFreshnessRef,
} from "./freshness-flow.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const PAYLOAD = {
  entryId: "kb-2026-0001",
  path: "knowledge/hardware/kb-2026-0001.md",
  title: "タイトル",
  ownerGithub: "yamada",
  ownerDiscord: "111",
  lastVerified: "2026-01-01",
};

function entryRaw(over: { status?: string } = {}): string {
  return [
    "---",
    "id: kb-2026-0001",
    "title: タイトル",
    "type: fact",
    "domain: hardware",
    "sources:",
    "  - kind: discord",
    '    url: "https://discord.com/channels/1/2/3"',
    "confidence: high",
    `status: ${over.status ?? "active"}`,
    'created: "2026-01-01"',
    'last_verified: "2026-01-01"',
    "owner: yamada",
    "---",
    "",
    "本文。",
    "",
  ].join("\n");
}

function action(over: { id?: string; state?: string } = {}): PendingAction {
  return {
    id: over.id ?? "act-1",
    type: FRESHNESS_ACTION_TYPE,
    queryId: null,
    payloadJson: JSON.stringify(PAYLOAD),
    state: over.state ?? "sent",
    createdAt: "2026-07-15T11:00:00+09:00",
  };
}

describe("buildFreshnessDm / parseFreshnessRef", () => {
  it("DM 本文の ref 行からアクション id を逆引きできる(往復)", () => {
    const dm = buildFreshnessDm(PAYLOAD, "abc-123");
    expect(dm).toContain("タイトル");
    expect(dm).toContain(PAYLOAD.path);
    expect(parseFreshnessRef(dm)).toBe("abc-123");
  });

  it("ref が無い本文は null", () => {
    expect(parseFreshnessRef("ただの DM")).toBeNull();
  });
});

describe("freshnessReactionDecision(ADR-0019 D2)", () => {
  const base = {
    reactorIsBot: false,
    isDm: true,
    messageAuthorIsSelf: true,
    content: buildFreshnessDm(PAYLOAD, "act-1"),
  };

  it("👍/✏️/🗑 を操作へ写像する(変異セレクタの有無に依らない)", () => {
    expect(freshnessReactionDecision({ ...base, emojiName: "👍" })).toEqual({
      act: true,
      kind: "verify",
      actionId: "act-1",
    });
    expect(freshnessReactionDecision({ ...base, emojiName: "✏️" })).toMatchObject({
      kind: "edit",
    });
    expect(freshnessReactionDecision({ ...base, emojiName: "🗑️" })).toMatchObject({
      kind: "trash",
    });
    expect(freshnessReactionDecision({ ...base, emojiName: "\u{1F5D1}" })).toMatchObject({
      kind: "trash",
    });
  });

  it("対象外: 他の絵文字 / bot 自身 / guild メッセージ / 他人の DM / ref 無し", () => {
    expect(freshnessReactionDecision({ ...base, emojiName: "🎉" }).act).toBe(false);
    expect(freshnessReactionDecision({ ...base, emojiName: "👍", reactorIsBot: true }).act).toBe(
      false,
    );
    expect(freshnessReactionDecision({ ...base, emojiName: "👍", isDm: false }).act).toBe(false);
    expect(
      freshnessReactionDecision({ ...base, emojiName: "👍", messageAuthorIsSelf: false }).act,
    ).toBe(false);
    expect(freshnessReactionDecision({ ...base, emojiName: "👍", content: "ref 無し" }).act).toBe(
      false,
    );
  });
});

interface Harness {
  deps: FreshnessApplyDeps;
  commits: { message: string; files: { path: string; content: string }[] }[];
  prs: { head: string; body: string; files: { path: string; content: string }[] }[];
  writes: Map<string, string>;
}

function makeDeps(over: {
  actions?: PendingAction[];
  raw?: string | null;
  validateOk?: boolean;
}): Harness {
  const store = createMemoryStore();
  for (const a of over.actions ?? [action()]) store.queueAction(a);
  const commits: Harness["commits"] = [];
  const prs: Harness["prs"] = [];
  const writes = new Map<string, string>();
  const deps: FreshnessApplyDeps = {
    store,
    gh: {
      commitFiles: async (input: {
        message: string;
        files: { path: string; content: string }[];
      }) => {
        commits.push({ message: input.message, files: input.files });
        return { sha: "deadbeef" };
      },
      createPullRequest: async (input: {
        head: string;
        body: string;
        files: { path: string; content: string }[];
      }) => {
        prs.push({ head: input.head, body: input.body, files: input.files });
        return { number: 7, url: "https://github.com/org/knowledge-base/pull/7" };
      },
    } as unknown as GhClient,
    kbRepo: "org/knowledge-base",
    baseBranch: "main",
    syncKbClone: async () => "/kb",
    readFile: async (p) => {
      if (over.raw === null || p !== `/kb/${PAYLOAD.path}`) throw new Error(`ENOENT: ${p}`);
      return over.raw ?? entryRaw();
    },
    writeFile: async (p, c) => {
      writes.set(p, c);
    },
    validate: async () => ({ ok: over.validateOk ?? true, problems: [] }),
    today: () => "2026-07-15",
    makeId: () => "new-id",
    nowIso: () => "2026-07-15T12:00:00+09:00",
    logger,
  };
  return { deps, commits, prs, writes };
}

function stateOf(store: FreshnessApplyDeps["store"], id: string): string | undefined {
  return store.listPendingActions(FRESHNESS_ACTION_TYPE).find((a) => a.id === id)?.state;
}

describe("applyFreshnessReaction(👍✏️🗑 の 3 分岐)", () => {
  it("👍: last_verified を今日へ更新して main 直 commit + 消費", async () => {
    const h = makeDeps({});
    const reply = await applyFreshnessReaction("verify", "act-1", h.deps);
    expect(reply).toContain("2026-07-15");
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.files[0]?.content).toContain('last_verified: "2026-07-15"');
    expect(h.commits[0]?.message).toContain("👍");
    expect(stateOf(h.deps.store, "act-1")).toBe("done");
  });

  it("👍 の二重リアクションは冪等(2 回目は commit しない)", async () => {
    const h = makeDeps({});
    await applyFreshnessReaction("verify", "act-1", h.deps);
    const reply = await applyFreshnessReaction("verify", "act-1", h.deps);
    expect(reply).toContain("処理済み");
    expect(h.commits).toHaveLength(1);
  });

  it("🗑: status: stale へ commit + 矛盾検出キューへ積む", async () => {
    const h = makeDeps({});
    const reply = await applyFreshnessReaction("trash", "act-1", h.deps);
    expect(reply).toContain("stale");
    expect(h.commits[0]?.files[0]?.content).toContain('status: "stale"');
    const contradictions = h.deps.store.listPendingActions(CONTRADICTION_ACTION_TYPE);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.state).toBe("pending");
    expect(stateOf(h.deps.store, "act-1")).toBe("done");
  });

  it("✏️: last_verified だけ進めた雛形 PR を作り、本文に現エントリ全文を載せる", async () => {
    const h = makeDeps({});
    const reply = await applyFreshnessReaction("edit", "act-1", h.deps);
    expect(reply).toContain("https://github.com/org/knowledge-base/pull/7");
    expect(h.prs).toHaveLength(1);
    expect(h.prs[0]?.head).toBe("freshness/kb-2026-0001-act-1");
    expect(h.prs[0]?.body).toContain("本文。");
    expect(h.prs[0]?.files[0]?.content).toContain('last_verified: "2026-07-15"');
    expect(h.commits).toHaveLength(0);
    expect(stateOf(h.deps.store, "act-1")).toBe("done");
  });

  it("validateRepo が失敗したら commit せず pending 温存(再リアクションで再試行可)", async () => {
    const h = makeDeps({ validateOk: false });
    const reply = await applyFreshnessReaction("verify", "act-1", h.deps);
    expect(reply).toContain("⛔");
    expect(h.commits).toHaveLength(0);
    expect(stateOf(h.deps.store, "act-1")).toBe("sent");
  });

  it("既に active でないエントリは消費だけ進める(commit しない)", async () => {
    const h = makeDeps({ raw: entryRaw({ status: "stale" }) });
    const reply = await applyFreshnessReaction("verify", "act-1", h.deps);
    expect(reply).toContain("active ではありません");
    expect(h.commits).toHaveLength(0);
    expect(stateOf(h.deps.store, "act-1")).toBe("done");
  });

  it("エントリが消えていたら消費だけ進める", async () => {
    const h = makeDeps({ raw: null });
    const reply = await applyFreshnessReaction("verify", "act-1", h.deps);
    expect(reply).toContain("見つかりません");
    expect(h.commits).toHaveLength(0);
    expect(stateOf(h.deps.store, "act-1")).toBe("done");
  });
});

describe("drainFreshnessDms(DM 送信 worker)", () => {
  it("pending を DM して state:'sent' へ前進(再起動しても二重送信しない)", async () => {
    const store = createMemoryStore();
    store.queueAction(action({ state: "pending" }));
    const sent: { userId: string; content: string }[] = [];
    const deps = {
      logger,
      store,
      dm: async (userId: string, content: string) => {
        sent.push({ userId, content });
      },
    };
    await drainFreshnessDms(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.userId).toBe("111");
    expect(parseFreshnessRef(sent[0]?.content ?? "")).toBe("act-1");
    expect(stateOf(store, "act-1")).toBe("sent");
    // 2 回目の drain は何も送らない。
    await drainFreshnessDms(deps);
    expect(sent).toHaveLength(1);
  });

  it("DM 送信失敗は pending 温存(次回 kick で再試行・14 日で checker が自動 stale)", async () => {
    const store = createMemoryStore();
    store.queueAction(action({ state: "pending" }));
    const deps = {
      logger,
      store,
      dm: async () => {
        throw new Error("cannot DM");
      },
    };
    await drainFreshnessDms(deps);
    expect(stateOf(store, "act-1")).toBe("pending");
  });

  it("payload が壊れた pending は破棄(done)する", async () => {
    const store = createMemoryStore();
    store.queueAction({ ...action({ state: "pending" }), payloadJson: "{broken" });
    const deps = { logger, store, dm: async () => {} };
    await drainFreshnessDms(deps);
    expect(stateOf(store, "act-1")).toBe("done");
  });
});
