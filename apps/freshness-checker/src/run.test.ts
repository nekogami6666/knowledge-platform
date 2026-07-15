import { FRESHNESS_ACTION_TYPE, parseFreshnessPayload } from "@stratum/discord-bot/freshness";
import type { BotStore, PendingAction } from "@stratum/discord-bot/store";
import type { GhClient } from "@stratum/gh-client";
import { describe, expect, it } from "vitest";
import type { Logger } from "./logger.js";
import { isoJst, jstDateKey, type RunDeps, runFreshnessChecker } from "./run.js";

// now = JST 2026-07-15 12:00(fact 既定 180 日: last_verified 2026-01-01 → due 2026-06-30 = 超過)。
const NOW = new Date("2026-07-15T03:00:00Z");

function entryRaw(over: { id?: string; lastVerified?: string; owner?: string }): string {
  return [
    "---",
    `id: ${over.id ?? "kb-2026-0001"}`,
    "title: タイトル",
    "type: fact",
    "domain: hardware",
    "sources:",
    "  - kind: discord",
    '    url: "https://discord.com/channels/1/2/3"',
    "confidence: high",
    "status: active",
    'created: "2026-01-01"',
    `last_verified: "${over.lastVerified ?? "2026-01-01"}"`,
    `owner: ${over.owner ?? "yamada"}`,
    "---",
    "",
    "本文。",
    "",
  ].join("\n");
}

const MEMBERS_YAML = 'members:\n  - github: yamada\n    discord: "111"\n';

interface FakeStore extends BotStore {
  queued: PendingAction[];
  doneIds: string[];
}

function fakeStore(actions: PendingAction[] = []): FakeStore {
  const queued: PendingAction[] = [];
  const doneIds: string[] = [];
  return {
    queued,
    doneIds,
    recordQuery: () => {},
    getQuery: () => undefined,
    listQueries: () => [],
    setFeedback: () => {},
    queueAction: (a) => queued.push(a),
    listPendingActions: (type) => actions.filter((a) => type === undefined || a.type === type),
    markActionDone: (id) => doneIds.push(id),
    hitRateLimit: () => ({ count: 1, allowed: true }),
    close: () => {},
  };
}

interface Harness {
  deps: RunDeps;
  store: FakeStore;
  writes: Map<string, string>;
  commits: unknown[];
  ops: string[];
  warns: string[];
  reserved: string[];
}

function makeHarness(over: {
  files?: { path: string; raw: string }[];
  actions?: PendingAction[];
  disk?: Record<string, string>;
  real?: boolean;
  membersYaml?: string | null;
  validateOk?: boolean;
  limit?: number;
}): Harness {
  const store = fakeStore(over.actions ?? []);
  const writes = new Map<string, string>();
  const commits: unknown[] = [];
  const ops: string[] = [];
  const warns: string[] = [];
  const reserved: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (m) => warns.push(m),
    error: (m) => warns.push(m),
  };
  const disk = new Map<string, string>(Object.entries(over.disk ?? {}));
  if (over.membersYaml !== null) {
    disk.set("/kb/_meta/members.yaml", over.membersYaml ?? MEMBERS_YAML);
  }
  const limit = over.limit ?? 2;
  const counts = new Map<string, number>();
  const deps: RunDeps = {
    config: {
      kb_repo: "org/knowledge-base",
      kb_dir: "kb",
      base_branch: "main",
      daily_limit_per_owner: limit,
      stale_after_days: 14,
    },
    store,
    syncKb: async () => ({ absDir: "/kb", resolvedCommit: "abc123" }),
    gh: {
      commitFiles: async (input: unknown) => {
        commits.push(input);
        return { commitSha: "deadbeef" };
      },
    } as unknown as GhClient,
    validate: async () => ({
      ok: over.validateOk ?? true,
      problems: over.validateOk === false ? [1] : [],
    }),
    listKnowledgeFiles: async () => over.files ?? [],
    readFile: async (p) => {
      const v = disk.get(p) ?? (writes.has(p) ? writes.get(p) : undefined);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: async (p, c) => {
      writes.set(p, c);
    },
    postOps: async (c) => {
      ops.push(c);
    },
    reserveOwner: (discordId) => {
      reserved.push(discordId);
      const n = (counts.get(discordId) ?? 0) + 1;
      counts.set(discordId, n);
      return n <= limit;
    },
    makeId: () => `act-${store.queued.length + 1}`,
    now: () => NOW,
    logger,
    real: over.real ?? true,
  };
  return { deps, store, writes, commits, ops, warns, reserved };
}

function liveAction(over: { id?: string; path?: string; createdAt?: string }): PendingAction {
  return {
    id: over.id ?? "act-old",
    type: FRESHNESS_ACTION_TYPE,
    queryId: null,
    payloadJson: JSON.stringify({
      entryId: "kb-2026-0001",
      path: over.path ?? "knowledge/hardware/kb-2026-0001.md",
      title: "タイトル",
      ownerGithub: "yamada",
      ownerDiscord: "111",
      lastVerified: "2026-01-01",
    }),
    state: "pending",
    createdAt: over.createdAt ?? isoJst(NOW),
  };
}

describe("runFreshnessChecker(§6.7 / ADR-0019)", () => {
  const OVERDUE = { path: "knowledge/hardware/kb-2026-0001.md", raw: entryRaw({}) };

  it("real: 期限超過 + owner 登載 → pending_actions へ投入(payload は契約 schema で往復可能)", async () => {
    const h = makeHarness({ files: [OVERDUE] });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.queued).toBe(1);
    expect(h.store.queued).toHaveLength(1);
    const a = h.store.queued[0];
    expect(a?.type).toBe(FRESHNESS_ACTION_TYPE);
    expect(a?.state).toBe("pending");
    expect(a?.createdAt).toBe(isoJst(NOW));
    expect(parseFreshnessPayload(a?.payloadJson ?? null)).toEqual({
      entryId: "kb-2026-0001",
      path: OVERDUE.path,
      title: "タイトル",
      ownerGithub: "yamada",
      ownerDiscord: "111",
      lastVerified: "2026-01-01",
    });
  });

  it("dry-run: 投入予定は数えるが store には書かない", async () => {
    const h = makeHarness({ files: [OVERDUE], real: false });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary).toMatchObject({ queued: 1, dryRun: true });
    expect(h.store.queued).toHaveLength(0);
    expect(h.store.doneIds).toHaveLength(0);
    expect(h.commits).toHaveLength(0);
  });

  it("生きているアクションがあるエントリは再投入しない(冪等・ADR-0019 D4)", async () => {
    const h = makeHarness({ files: [OVERDUE], actions: [liveAction({})] });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.skippedLive).toBe(1);
    expect(h.store.queued).toHaveLength(0);
  });

  it("owner 別 1 日 N 件(既定 2)。超過分は翌日以降に回る", async () => {
    const h = makeHarness({
      files: [
        { path: "knowledge/hw/kb-2026-0001.md", raw: entryRaw({ id: "kb-2026-0001" }) },
        { path: "knowledge/hw/kb-2026-0002.md", raw: entryRaw({ id: "kb-2026-0002" }) },
        { path: "knowledge/hw/kb-2026-0003.md", raw: entryRaw({ id: "kb-2026-0003" }) },
      ],
    });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.queued).toBe(2);
    expect(summary.skippedRateLimited).toBe(1);
  });

  it("members.yaml 未登載の owner は warn + スキップ(日次予算を消費しない)", async () => {
    const h = makeHarness({
      files: [{ path: "knowledge/hw/kb-2026-0001.md", raw: entryRaw({ owner: "unassigned" }) }],
    });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.skippedNoMember).toBe(1);
    expect(h.reserved).toHaveLength(0);
    expect(h.warns.length).toBeGreaterThan(0);
  });

  it("members.yaml が読めなければ全件スキップ(warn)して落ちない", async () => {
    const h = makeHarness({ files: [OVERDUE], membersYaml: null });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.queued).toBe(0);
    expect(summary.skippedNoMember).toBe(1);
  });

  it("real: 14 日無応答 → status: stale へ 1 コミット降格 + 消費 + ops 報告(同ランで再投入しない)", async () => {
    const path = "knowledge/hardware/kb-2026-0001.md";
    const h = makeHarness({
      files: [{ path, raw: entryRaw({}) }],
      actions: [liveAction({ createdAt: "2026-06-20T10:00:00+09:00" })],
      disk: { [`/kb/${path}`]: entryRaw({}) },
    });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.staled).toBe(1);
    expect(h.writes.get(`/kb/${path}`)).toContain('status: "stale"');
    expect(h.commits).toHaveLength(1);
    expect(h.store.doneIds).toEqual(["act-old"]);
    expect(h.ops[0]).toContain(path);
    // 降格した path は(clone 上はまだ active に見えても)このランでは再投入しない。
    expect(h.store.queued).toHaveLength(0);
    expect(summary.skippedLive).toBe(1);
  });

  it("dry-run: 降格は staging + 計画ログまで(commit も消費も報告もしない)", async () => {
    const path = "knowledge/hardware/kb-2026-0001.md";
    const h = makeHarness({
      files: [],
      actions: [liveAction({ createdAt: "2026-06-20T10:00:00+09:00" })],
      disk: { [`/kb/${path}`]: entryRaw({}) },
      real: false,
    });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.staled).toBe(1);
    expect(h.commits).toHaveLength(0);
    expect(h.store.doneIds).toHaveLength(0);
    expect(h.ops).toHaveLength(0);
  });

  it("validateRepo が失敗したら降格を commit しない(ADR-0004 D2)", async () => {
    const path = "knowledge/hardware/kb-2026-0001.md";
    const h = makeHarness({
      files: [],
      actions: [liveAction({ createdAt: "2026-06-20T10:00:00+09:00" })],
      disk: { [`/kb/${path}`]: entryRaw({}) },
      validateOk: false,
    });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.staled).toBe(0);
    expect(h.commits).toHaveLength(0);
    expect(h.store.doneIds).toHaveLength(0);
  });

  it("降格対象のエントリが clone から消えていたら消費だけ進める", async () => {
    const h = makeHarness({
      files: [],
      actions: [liveAction({ createdAt: "2026-06-20T10:00:00+09:00" })],
    });
    const summary = await runFreshnessChecker(h.deps);
    expect(summary.staled).toBe(0);
    expect(h.store.doneIds).toEqual(["act-old"]);
    expect(h.commits).toHaveLength(0);
  });

  it("jstDateKey は JST の日付(UTC 深夜でも日本の当日)", () => {
    expect(jstDateKey(new Date("2026-07-14T16:00:00Z"))).toBe("2026-07-15");
    expect(jstDateKey(new Date("2026-07-14T14:59:00Z"))).toBe("2026-07-14");
  });
});
