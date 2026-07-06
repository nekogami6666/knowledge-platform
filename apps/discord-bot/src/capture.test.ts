import type { GhClient } from "@stratum/gh-client";
import { GhClientError } from "@stratum/gh-client";
import type { PromptStore } from "@stratum/llm";
import type { MessageReaction, User } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  allocateCaptureId,
  buildCaptureEntry,
  buildCapturePrompt,
  type CaptureCandidate,
  type CaptureDeps,
  captureBranch,
  captureCandidateSchema,
  captureDecision,
  type DraftSearchFn,
  handleLightbulb,
  jstDayKey,
  runDraft,
  runTriage,
  type TriageSearchFn,
  triageResultSchema,
} from "./capture.js";
import type { ChannelsConfig } from "./config.js";
import type { BotStore } from "./db.js";

const channels = (over: Partial<ChannelsConfig> = {}): ChannelsConfig => ({
  allow: ["CH1"],
  permanent_exclude: [],
  ...over,
});

const URL = "https://discord.com/channels/1/2/3";

// --- 純関数 -------------------------------------------------------------------

describe("captureDecision (§6.4 のガード判定)", () => {
  const base = {
    emojiName: "💡" as string | null,
    reactorIsBot: false,
    inGuild: true,
    channelId: "CH1",
    channels: channels(),
  };
  it("💡 × 人間 × guild × allowlist → capture", () => {
    expect(captureDecision(base)).toEqual({ capture: true });
  });
  it("💡 以外は無視", () => {
    expect(captureDecision({ ...base, emojiName: "👍" })).toEqual({
      capture: false,
      reason: "not-lightbulb",
    });
  });
  it("bot のリアクションは無視", () => {
    expect(captureDecision({ ...base, reactorIsBot: true })).toEqual({
      capture: false,
      reason: "bot-reactor",
    });
  });
  it("DM(guild 外)は対象外(§6.4)", () => {
    expect(captureDecision({ ...base, inGuild: false })).toEqual({
      capture: false,
      reason: "not-guild",
    });
  });
  it("allowlist 外のチャンネルは対象外(§9.3 default-deny)", () => {
    expect(captureDecision({ ...base, channelId: "OTHER" })).toEqual({
      capture: false,
      reason: "channel-not-allowed",
    });
  });
});

describe("jstDayKey / captureBranch", () => {
  it("JST の日付でバケットする(UTC 16時 = JST 翌日)", () => {
    expect(jstDayKey(new Date("2026-07-06T01:00:00Z"))).toBe("2026-07-06");
    expect(jstDayKey(new Date("2026-07-06T16:00:00Z"))).toBe("2026-07-07");
  });
  it("ブランチ名は capture/<messageId>(冪等キー)", () => {
    expect(captureBranch("MSG1")).toBe("capture/MSG1");
  });
});

const candidate = (over: Partial<CaptureCandidate> = {}): CaptureCandidate => ({
  title: "高湿度と Y 軸脱調",
  entryType: "fact",
  domain: "hardware",
  body: "40%RH 以下に保つ。",
  confidence: "high",
  ...over,
});

describe("captureCandidateSchema", () => {
  it("有効な候補は通る(tags 省略可)/ decision は選べない", () => {
    expect(captureCandidateSchema.safeParse(candidate()).success).toBe(true);
    expect(
      captureCandidateSchema.safeParse({ ...candidate(), entryType: "decision" }).success,
    ).toBe(false);
  });
});

describe("buildCaptureEntry", () => {
  const now = new Date("2026-07-06T01:00:00Z"); // JST 10:00

  it("KnowledgeEntry に写す(discord 出典・owner・active・JST 日付)", () => {
    const built = buildCaptureEntry("kb-2026-0143", candidate(), URL, "yamada", now);
    expect(built.frontmatter).toMatchObject({
      id: "kb-2026-0143",
      type: "fact",
      domain: "hardware",
      owner: "yamada",
      people: ["yamada"],
      status: "active",
      created: "2026-07-06",
      sources: [{ kind: "discord", url: URL }],
    });
    expect(built.path).toBe("knowledge/hardware/kb-2026-0143-entry.md");
  });

  it("slug は ASCII kebab 化してパスに使う", () => {
    const built = buildCaptureEntry(
      "kb-2026-0143",
      candidate({ slug: "Humidity Destep!" }),
      URL,
      "y",
      now,
    );
    expect(built.path).toBe("knowledge/hardware/kb-2026-0143-humidity-destep.md");
  });
});

describe("allocateCaptureId (clone なしの in-memory 採番)", () => {
  it("既存 counter をシードに次番号を採番し、更新後 JSON を返す", async () => {
    const gh = {
      getFileContents: vi.fn(async () => ({
        content: JSON.stringify({ kb: { "2026": 142 } }),
        sha: "S",
      })),
    } as unknown as GhClient;
    const r = await allocateCaptureId(gh, "org/knowledge-base", new Date("2026-07-06T01:00:00Z"));
    expect(r.id).toBe("kb-2026-0143");
    expect(JSON.parse(r.counterJson)).toEqual({ kb: { "2026": 143 } });
    expect(r.counterJson.endsWith("\n")).toBe(true); // ローカル実装と同じ整形
  });

  it("counter 未作成の repo では {} から開始(kb-<年>-0001)", async () => {
    const gh = { getFileContents: vi.fn(async () => null) } as unknown as GhClient;
    const r = await allocateCaptureId(gh, "org/knowledge-base", new Date("2026-07-06T01:00:00Z"));
    expect(r.id).toBe("kb-2026-0001");
  });
});

// --- LLM ステップ(seam)-------------------------------------------------------

const fakePromptStore: PromptStore = {
  read: async () => "---\nrole: fast\n---\nCAPTURE RULES",
};

describe("runTriage / runDraft", () => {
  it("triage はツール無し単発(allowedTools:[]・role は frontmatter・★ 付き会話を渡す)", async () => {
    const captured: { opts?: unknown } = {};
    const search: TriageSearchFn = async (opts) => {
      captured.opts = opts;
      return { value: { capture: true, reason: "ok" }, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await runTriage(
      { context: "★ yamada: 40%RH 以下に保つ", cwd: "/clones" },
      { promptStore: fakePromptStore, search },
    );
    expect(r.capture).toBe(true);
    const opts = captured.opts as {
      allowedTools: string[];
      role: string;
      app: string;
      outputSchema: unknown;
      systemPrompt: string;
      prompt: string;
    };
    expect(opts.allowedTools).toEqual([]);
    expect(opts.role).toBe("fast");
    expect(opts.app).toBe("discord-bot");
    expect(opts.outputSchema).toBe(triageResultSchema);
    expect(opts.systemPrompt).toBe("CAPTURE RULES");
    expect(opts.prompt).toContain("★ yamada: 40%RH");
  });

  it("draft は candidate スキーマで受ける", async () => {
    const captured: { opts?: unknown } = {};
    const search: DraftSearchFn = async (opts) => {
      captured.opts = opts;
      return { value: candidate(), usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await runDraft(
      { context: "★ yamada: 40%RH", cwd: "/clones" },
      { promptStore: fakePromptStore, search },
    );
    expect(r).toEqual(candidate());
    expect((captured.opts as { outputSchema: unknown }).outputSchema).toBe(captureCandidateSchema);
  });

  it("buildCapturePrompt は会話を柵で囲む", () => {
    const p = buildCapturePrompt("★ a: b");
    expect(p).toContain("--- 会話ここから ---");
    expect(p).toContain("★ a: b");
  });
});

// --- handleLightbulb(合成)----------------------------------------------------

function fakeLogger(): { logger: Logger; errors: unknown[]; warns: unknown[] } {
  const errors: unknown[] = [];
  const warns: unknown[] = [];
  const l = {
    child: () => l,
    error: (obj: unknown) => {
      errors.push(obj);
    },
    warn: (obj: unknown) => {
      warns.push(obj);
    },
    info: () => {},
    debug: () => {},
  };
  return { logger: l as unknown as Logger, errors, warns };
}

function fakeStore(opts: { rateAllowed?: boolean } = {}): { store: BotStore } {
  const store = {
    hitRateLimit: vi.fn(() => ({ count: 1, allowed: opts.rateAllowed ?? true })),
  };
  return { store: store as unknown as BotStore };
}

function fakeGh(opts: { existingHead?: string; createThrows?: unknown } = {}): {
  gh: GhClient;
  created: unknown[];
  list: ReturnType<typeof vi.fn>;
} {
  const created: unknown[] = [];
  const list = vi.fn(async () =>
    opts.existingHead !== undefined
      ? [
          {
            number: 5,
            title: "t",
            headRef: opts.existingHead,
            url: "https://github.com/org/knowledge-base/pull/5",
          },
        ]
      : [],
  );
  const gh = {
    listPullRequests: list,
    getFileContents: vi.fn(async () => ({
      content: JSON.stringify({ kb: { "2026": 142 } }),
      sha: "S",
    })),
    createPullRequest: vi.fn(async (o: unknown) => {
      if (opts.createThrows !== undefined) throw opts.createThrows;
      created.push(o);
      return { number: 7, url: "https://github.com/org/knowledge-base/pull/7" };
    }),
  } as unknown as GhClient;
  return { gh, created, list };
}

function fakeContext(
  over: { emoji?: string; guildId?: string | null; channelId?: string; userBot?: boolean } = {},
): { reaction: MessageReaction; user: User; dms: string[] } {
  const dms: string[] = [];
  const mkMsg = (id: string, content: string, ts: number) => ({
    id,
    content,
    createdTimestamp: ts,
    author: { username: "yamada", bot: false },
  });
  const target = {
    ...mkMsg("MSG1", "40%RH 以下に保つ必要がある", 2),
    partial: false,
    guildId: over.guildId !== undefined ? over.guildId : "G1",
    channelId: over.channelId ?? "CH1",
    url: URL,
    channel: {
      isThread: () => false,
      messages: {
        fetch: async () =>
          new Map([
            ["MSG0", mkMsg("MSG0", "湿度の件どうなった?", 1)],
            ["MSG1", mkMsg("MSG1", "40%RH 以下に保つ必要がある", 2)],
          ]),
      },
    },
  };
  const reaction = {
    partial: false,
    emoji: { name: over.emoji ?? "💡" },
    message: target,
  };
  const user = {
    partial: false,
    bot: over.userBot ?? false,
    id: "U1",
    send: async (s: string) => {
      dms.push(s);
    },
  };
  return {
    reaction: reaction as unknown as MessageReaction,
    user: user as unknown as User,
    dms,
  };
}

const triageYes: TriageSearchFn = async () => ({
  value: { capture: true, reason: "ok" },
  usage: { inputTokens: 1, outputTokens: 1 },
});
const triageNo: TriageSearchFn = async () => ({
  value: { capture: false, reason: "雑談" },
  usage: { inputTokens: 1, outputTokens: 1 },
});
const draftFixed: DraftSearchFn = async () => ({
  value: candidate(),
  usage: { inputTokens: 1, outputTokens: 1 },
});

function mkDeps(
  logger: Logger,
  store: BotStore,
  gh: GhClient | undefined,
  over: Partial<CaptureDeps> = {},
): CaptureDeps {
  return {
    logger,
    channels: channels(),
    store,
    members: { members: [{ github: "yamada", discord: "U1" }] },
    cwd: "/clones",
    ops: { channel_id: "OPS", kb_repo: "org/knowledge-base" },
    gh,
    promptStore: fakePromptStore,
    triageSearch: triageYes,
    draftSearch: draftFixed,
    now: () => new Date("2026-07-06T01:00:00Z"),
    ...over,
  };
}

describe("handleLightbulb (§6.4 ③-a)", () => {
  it("💡 → triage 成立 → 単発 PR(entry + id-counter)+ DM(PR URL)", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh, created } = fakeGh();
    const { reaction, user, dms } = fakeContext();
    await handleLightbulb(reaction, user, mkDeps(logger, store, gh));
    expect(created).toHaveLength(1);
    const pr = created[0] as { head: string; repo: string; files: { path: string }[] };
    expect(pr.repo).toBe("org/knowledge-base");
    expect(pr.head).toBe("capture/MSG1");
    const paths = pr.files.map((f) => f.path);
    expect(paths).toContain("knowledge/hardware/kb-2026-0143-entry.md");
    expect(paths).toContain("_meta/id-counter.json");
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("https://github.com/org/knowledge-base/pull/7");
    expect(dms[0]).toContain("👍");
  });

  it("triage 不成立なら PR も DM も無し(静かに終了)", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh, created } = fakeGh();
    const { reaction, user, dms } = fakeContext();
    await handleLightbulb(reaction, user, mkDeps(logger, store, gh, { triageSearch: triageNo }));
    expect(created).toHaveLength(0);
    expect(dms).toHaveLength(0);
  });

  it("💡 以外・bot・DM・未許可チャンネルは gh に触れない", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    for (const over of [
      { emoji: "👍" },
      { userBot: true },
      { guildId: null },
      { channelId: "OTHER" },
    ]) {
      const { gh, list } = fakeGh();
      const { reaction, user } = fakeContext(over);
      await handleLightbulb(reaction, user, mkDeps(logger, store, gh));
      expect(list).not.toHaveBeenCalled();
    }
  });

  it("機能 OFF(gh なし / kb_repo null / promptStore なし)は完全 no-op", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh } = fakeGh();
    for (const over of [
      { gh: undefined },
      { ops: { channel_id: "OPS", kb_repo: null } },
      { promptStore: undefined },
    ] as Partial<CaptureDeps>[]) {
      const { reaction, user, dms } = fakeContext();
      await handleLightbulb(reaction, user, { ...mkDeps(logger, store, gh), ...over });
      expect(dms).toHaveLength(0);
    }
  });

  it("日次上限超過は DM 案内のみ(PR 無し・§6.4 乱用対策)", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore({ rateAllowed: false });
    const { gh, created } = fakeGh();
    const { reaction, user, dms } = fakeContext();
    await handleLightbulb(reaction, user, mkDeps(logger, store, gh));
    expect(created).toHaveLength(0);
    expect(dms[0]).toContain("上限");
  });

  it("既存 PR(同 head)があれば再作成せず DM 案内(冪等)", async () => {
    const { logger } = fakeLogger();
    const { store } = fakeStore();
    const { gh, created } = fakeGh({ existingHead: "capture/MSG1" });
    const { reaction, user, dms } = fakeContext();
    await handleLightbulb(reaction, user, mkDeps(logger, store, gh));
    expect(created).toHaveLength(0);
    expect(dms[0]).toContain("既に");
    expect(dms[0]).toContain("pull/5");
  });

  it("createPullRequest の CONFLICT(並行 💡)は warn で封じ込め", async () => {
    const { logger, errors, warns } = fakeLogger();
    const { store } = fakeStore();
    const { gh } = fakeGh({ createThrows: new GhClientError("CONFLICT", "branch exists") });
    const { reaction, user } = fakeContext();
    await expect(
      handleLightbulb(reaction, user, mkDeps(logger, store, gh)),
    ).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it("その他の throw は log.error で封じ込め(リスナを落とさない)", async () => {
    const { logger, errors } = fakeLogger();
    const { store } = fakeStore();
    const { gh } = fakeGh({ createThrows: new Error("boom") });
    const { reaction, user } = fakeContext();
    await expect(
      handleLightbulb(reaction, user, mkDeps(logger, store, gh)),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
