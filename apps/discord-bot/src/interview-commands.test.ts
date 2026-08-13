import type { GhClient } from "@stratum/gh-client";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "./db.js";
import {
  cancelInterviewCore,
  handleInterviewCommand,
  type InterviewCommandDeps,
  interviewStartDecision,
  normalizeKitOption,
  resolveKitPath,
  resolvePersonDisplay,
  startInterviewCore,
  statusInterviewCore,
} from "./interview-commands.js";
import {
  INTERVIEW_SESSION_ACTION_TYPE,
  type InterviewSessionPayload,
  interviewSessionPayloadSchema,
} from "./interview-session.js";

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const NOW = new Date("2026-08-13T03:00:00Z"); // = 12:00 JST
const VC = "222222222222222222";

function samplePayload(over: Partial<InterviewSessionPayload> = {}): InterviewSessionPayload {
  return {
    sessionId: "sess-1",
    person: "山田",
    topic: "リリース手順",
    kitPath: null,
    guildId: "G1",
    channelId: VC,
    starterId: "U-starter",
    participantIds: [],
    chunks: [],
    currentChunk: null,
    startedAtJst: "2026-08-13T11:30:00+09:00", // NOW の 30 分前
    ...over,
  };
}

function seedSession(
  store: ReturnType<typeof createMemoryStore>,
  state: string,
  payload: InterviewSessionPayload = samplePayload(),
): void {
  store.queueAction({
    id: "act-1",
    type: INTERVIEW_SESSION_ACTION_TYPE,
    queryId: null,
    payloadJson: JSON.stringify(payload),
    state,
    createdAt: "t",
  });
}

function mkDeps(over: Partial<InterviewCommandDeps> = {}): {
  deps: InterviewCommandDeps;
  store: ReturnType<typeof createMemoryStore>;
  aborts: string[];
} {
  const store = createMemoryStore();
  const aborts: string[] = [];
  let seq = 0;
  const deps: InterviewCommandDeps = {
    store,
    voiceVcChannelId: VC,
    armTtlMinutes: 120,
    maxRecordingMinutes: 15,
    hasActiveRecording: () => false,
    abortActiveRecording: async (reason) => {
      aborts.push(reason);
    },
    makeId: () => `id-${++seq}`,
    now: () => NOW,
    logger,
    ...over,
  };
  return { deps, store: (over.store as ReturnType<typeof createMemoryStore>) ?? store, aborts };
}

function fakeInteraction(opts: {
  sub: string;
  inGuild?: boolean;
  strings?: Record<string, string>;
}): {
  interaction: ChatInputCommandInteraction;
  replies: { content: string; ephemeral?: boolean }[];
} {
  const replies: { content: string; ephemeral?: boolean }[] = [];
  const interaction = {
    replied: false,
    deferred: false,
    inGuild: () => opts.inGuild ?? true,
    guildId: opts.inGuild === false ? null : "G1",
    user: { id: "U-starter" },
    options: {
      getSubcommand: () => opts.sub,
      getString: (name: string, required?: boolean) => {
        const v = opts.strings?.[name];
        if (v === undefined) {
          if (required === true) throw new Error(`required option ${name} missing`);
          return null;
        }
        return v;
      },
    },
    reply: async (o: { content: string; ephemeral?: boolean }) => {
      replies.push(o);
      (interaction as { replied: boolean }).replied = true;
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

const startStrings = { person: "山田", topic: "リリース手順" };

describe("interviewStartDecision(ADR-0028 D5 のガード判定)", () => {
  it("すべて満たせば ok", () => {
    expect(
      interviewStartDecision({
        hasActiveSession: false,
        recordingActive: false,
        vcConfigured: true,
      }),
    ).toEqual({ ok: true });
  });

  it("VC 録音が無効な環境は拒否(日本語 reason)", () => {
    const d = interviewStartDecision({
      hasActiveSession: false,
      recordingActive: false,
      vcConfigured: false,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("VC 録音が無効");
  });

  it("アクティブなセッションが既にあれば拒否(同時に 1 件)", () => {
    const d = interviewStartDecision({
      hasActiveSession: true,
      recordingActive: false,
      vcConfigured: true,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("進行中の interview セッション");
  });

  it("通常録音の進行中は拒否(録音に後からセッションを被せない)", () => {
    const d = interviewStartDecision({
      hasActiveSession: false,
      recordingActive: true,
      vcConfigured: true,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("通常の VC 録音が進行中");
  });
});

describe("normalizeKitOption(interviews/kits/ 前置の強制)", () => {
  it("素のファイル名・先頭スラッシュ付きに前置し、前置済みはそのまま", () => {
    expect(normalizeKitOption("yamada-release.md")).toBe("interviews/kits/yamada-release.md");
    expect(normalizeKitOption("/yamada-release.md")).toBe("interviews/kits/yamada-release.md");
    expect(normalizeKitOption("interviews/kits/yamada-release.md")).toBe(
      "interviews/kits/yamada-release.md",
    );
  });
});

describe("resolveKitPath(キット解決)", () => {
  const ghWith = (existing: string[]): { gh: GhClient; asked: string[] } => {
    const asked: string[] = [];
    const gh = {
      getFileContents: vi.fn(async ({ path }: { path: string }) => {
        asked.push(path);
        return existing.includes(path) ? { content: "kit", sha: "s" } : null;
      }),
    } as unknown as GhClient;
    return { gh, asked };
  };

  it("gh 未設定: 明示パスは無確認で採用(前置強制)・自動発見は null", async () => {
    expect(
      await resolveKitPath({ kitOption: "foo.md", person: "山田", topic: "手順" }, { logger }),
    ).toBe("interviews/kits/foo.md");
    expect(
      await resolveKitPath({ kitOption: null, person: "山田", topic: "手順" }, { logger }),
    ).toBeNull();
  });

  it("明示パスが main に存在すれば採用", async () => {
    const { gh } = ghWith(["interviews/kits/foo.md"]);
    expect(
      await resolveKitPath(
        { kitOption: "foo.md", person: "山田", topic: "手順" },
        { gh, kbRepo: "org/kb", logger },
      ),
    ).toBe("interviews/kits/foo.md");
  });

  it("明示パスが無ければ interviewKitPath(person, topic) へフォールバック", async () => {
    // 日本語 person/topic の slug は "x" フォールバック(kb-core interviewSlug)。
    const { gh } = ghWith(["interviews/kits/x-x.md"]);
    expect(
      await resolveKitPath(
        { kitOption: "missing.md", person: "山田", topic: "手順" },
        { gh, kbRepo: "org/kb", logger },
      ),
    ).toBe("interviews/kits/x-x.md");
  });

  it("どちらも無ければ null(キット無しで開始)", async () => {
    const { gh } = ghWith([]);
    expect(
      await resolveKitPath(
        { kitOption: null, person: "山田", topic: "手順" },
        { gh, kbRepo: "org/kb", logger },
      ),
    ).toBeNull();
  });

  it("存在確認の失敗(一時障害)は開始を妨げない: 明示パスを無確認で採用", async () => {
    const gh = {
      getFileContents: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as GhClient;
    expect(
      await resolveKitPath(
        { kitOption: "foo.md", person: "山田", topic: "手順" },
        { gh, kbRepo: "org/kb", logger },
      ),
    ).toBe("interviews/kits/foo.md");
  });
});

describe("resolvePersonDisplay(Discord ID → person 表記)", () => {
  const members = {
    members: [
      { name: "山田 太郎", github: "yamada", discord: "U-1", discord_alts: ["U-1b"] as [string] },
      { name: "佐藤", discord: "U-2" },
      { discord: "U-3" },
    ],
  };

  it("github を最優先で使う(別名 Discord でも一致)", () => {
    expect(resolvePersonDisplay(members, "U-1")).toBe("yamada");
    expect(resolvePersonDisplay(members, "U-1b")).toBe("yamada");
  });

  it("github 未所持は name へフォールバックする", () => {
    expect(resolvePersonDisplay(members, "U-2")).toBe("佐藤");
  });

  it("name も無ければ生の Discord ID を返す(未登載も同様)", () => {
    expect(resolvePersonDisplay(members, "U-3")).toBe("U-3");
    expect(resolvePersonDisplay(members, "U-unknown")).toBe("U-unknown");
  });
});

describe("startInterviewCore / statusInterviewCore / cancelInterviewCore(interaction 非依存コア)", () => {
  const startInput = {
    person: "山田",
    topic: "リリース手順",
    kitOption: null,
    guildId: "G1",
    starterId: "U-starter",
  };

  it("start: ガード拒否は ok:false + reason(store には書かない)", async () => {
    const { deps, store } = mkDeps({ hasActiveRecording: () => true });
    const result = await startInterviewCore(startInput, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("通常の VC 録音が進行中");
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(0);
  });

  it('start: 正常系は "armed" を積んで案内文を返す', async () => {
    const { deps, store } = mkDeps();
    const result = await startInterviewCore(startInput, deps);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("山田 × リリース手順");
    const actions = store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.state).toBe("armed");
    const payload = interviewSessionPayloadSchema.parse(JSON.parse(actions[0]?.payloadJson ?? ""));
    expect(payload).toMatchObject({ person: "山田", guildId: "G1", starterId: "U-starter" });
  });

  it("status: セッション無しは ok:false、あれば ok:true + 状態文", () => {
    const { deps, store } = mkDeps();
    expect(statusInterviewCore(deps)).toEqual({
      ok: false,
      message: "進行中のセッションはありません。",
    });
    seedSession(store, "armed");
    const result = statusInterviewCore(deps);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("armed");
  });

  it("cancel: recording は録音 abort + cancelled、無しは ok:false", async () => {
    const { deps, store, aborts } = mkDeps();
    expect((await cancelInterviewCore(deps)).ok).toBe(false);
    seedSession(store, "recording");
    const result = await cancelInterviewCore(deps);
    expect(result.ok).toBe(true);
    expect(aborts).toEqual(["interview cancel"]);
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("cancelled");
  });
});

describe("/interview start(handleInterviewCommand)", () => {
  it("guild 外は拒否する", async () => {
    const { deps, store } = mkDeps();
    const { interaction, replies } = fakeInteraction({
      sub: "start",
      inGuild: false,
      strings: startStrings,
    });
    await handleInterviewCommand(interaction, deps);
    expect(replies[0]?.content).toContain("サーバー内でのみ");
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(0);
  });

  it("重複セッション(armed)があれば拒否する", async () => {
    const { deps, store } = mkDeps();
    seedSession(store, "armed");
    const { interaction, replies } = fakeInteraction({ sub: "start", strings: startStrings });
    await handleInterviewCommand(interaction, deps);
    expect(replies[0]?.content).toContain("進行中の interview セッション");
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(1); // 追加されない
  });

  it("通常録音の進行中は拒否する", async () => {
    const { deps, store } = mkDeps({ hasActiveRecording: () => true });
    const { interaction, replies } = fakeInteraction({ sub: "start", strings: startStrings });
    await handleInterviewCommand(interaction, deps);
    expect(replies[0]?.content).toContain("通常の VC 録音が進行中");
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(0);
  });

  it('正常系: "armed" でキューに積み、VC・自動分割・cancel を ephemeral で案内する', async () => {
    const { deps, store } = mkDeps();
    const { interaction, replies } = fakeInteraction({ sub: "start", strings: startStrings });
    await handleInterviewCommand(interaction, deps);

    const actions = store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.state).toBe("armed");
    const payload = interviewSessionPayloadSchema.parse(JSON.parse(actions[0]?.payloadJson ?? ""));
    expect(payload).toMatchObject({
      sessionId: "id-1",
      person: "山田",
      topic: "リリース手順",
      kitPath: null, // gh 未設定 + kit オプション無し → 自動発見はしない
      guildId: "G1",
      channelId: VC,
      starterId: "U-starter",
      participantIds: [],
      chunks: [],
      currentChunk: null,
    });
    expect(payload.startedAtJst).toBe("2026-08-13T12:00:00+09:00"); // isoJst 流儀

    expect(replies[0]?.ephemeral).toBe(true);
    const content = replies[0]?.content ?? "";
    expect(content).toContain(`<#${VC}>`);
    expect(content).toContain("15 分ごとに自動分割");
    expect(content).toContain("数秒欠ける");
    expect(content).toContain("全員が退室するとセッション完了");
    expect(content).toContain("PR を DM");
    expect(content).toContain("/interview cancel");
    expect(content).toContain("キット無しで開始");
  });

  it("kit オプションは前置を強制して payload に採用する(gh 未設定 = 無確認)", async () => {
    const { deps, store } = mkDeps();
    const { interaction, replies } = fakeInteraction({
      sub: "start",
      strings: { ...startStrings, kit: "yamada-release.md" },
    });
    await handleInterviewCommand(interaction, deps);
    const payload = interviewSessionPayloadSchema.parse(
      JSON.parse(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.payloadJson ?? ""),
    );
    expect(payload.kitPath).toBe("interviews/kits/yamada-release.md");
    expect(replies[0]?.content).toContain("`interviews/kits/yamada-release.md`");
  });
});

describe("/interview status(handleInterviewCommand)", () => {
  it("セッション無しなら「進行中のセッションはありません」", async () => {
    const { deps } = mkDeps();
    const { interaction, replies } = fakeInteraction({ sub: "status" });
    await handleInterviewCommand(interaction, deps);
    expect(replies[0]).toEqual({ content: "進行中のセッションはありません。", ephemeral: true });
  });

  it("armed: 状態・経過・kitPath・TTL 残りを ephemeral 表示する", async () => {
    const { deps, store } = mkDeps();
    seedSession(store, "armed", samplePayload({ kitPath: "interviews/kits/x-x.md" }));
    const { interaction, replies } = fakeInteraction({ sub: "status" });
    await handleInterviewCommand(interaction, deps);
    const content = replies[0]?.content ?? "";
    expect(replies[0]?.ephemeral).toBe(true);
    expect(content).toContain("armed");
    expect(content).toContain("チャンク: 0 本");
    expect(content).toContain("経過: 30 分"); // NOW - startedAtJst
    expect(content).toContain("`interviews/kits/x-x.md`");
    expect(content).toContain("残り 90 分"); // TTL 120 - 経過 30
  });

  it("recording: チャンク数と録音中 seq を表示し、TTL は出さない", async () => {
    const { deps, store } = mkDeps();
    seedSession(
      store,
      "recording",
      samplePayload({
        chunks: [
          {
            seq: 1,
            meetingId: "vm-1",
            filePath: "/r/vm-1/recording.m4a",
            recordedAtJst: "2026-08-13T11:45:00+09:00",
            transcript: null,
          },
        ],
        currentChunk: { seq: 2, meetingId: "vm-2" },
      }),
    );
    const { interaction, replies } = fakeInteraction({ sub: "status" });
    await handleInterviewCommand(interaction, deps);
    const content = replies[0]?.content ?? "";
    expect(content).toContain("recording");
    expect(content).toContain("チャンク: 1 本(+ 録音中 seq 2)");
    expect(content).toContain("質問キット: 無し");
    expect(content).not.toContain("自動キャンセルまで");
  });
});

describe("/interview cancel(handleInterviewCommand)", () => {
  it("セッション無しなら案内のみ", async () => {
    const { deps, aborts } = mkDeps();
    const { interaction, replies } = fakeInteraction({ sub: "cancel" });
    await handleInterviewCommand(interaction, deps);
    expect(replies[0]?.content).toBe("進行中のセッションはありません。");
    expect(aborts).toHaveLength(0);
  });

  it("armed → cancelled(録音 abort は呼ばない)", async () => {
    const { deps, store, aborts } = mkDeps();
    seedSession(store, "armed");
    const { interaction, replies } = fakeInteraction({ sub: "cancel" });
    await handleInterviewCommand(interaction, deps);
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("cancelled");
    expect(aborts).toHaveLength(0);
    expect(replies[0]?.content).toContain("中止しました");
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it("recording → 録音 abort + cancelled", async () => {
    const { deps, store, aborts } = mkDeps();
    seedSession(store, "recording");
    const { interaction } = fakeInteraction({ sub: "cancel" });
    await handleInterviewCommand(interaction, deps);
    expect(aborts).toEqual(["interview cancel"]);
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("cancelled");
  });
});

describe("handleInterviewCommand(例外封じ込め)", () => {
  it("store が throw しても interaction へガード付きで通知して落ちない", async () => {
    const { deps } = mkDeps({
      store: {
        ...createMemoryStore(),
        listPendingActions: () => {
          throw new Error("sqlite locked");
        },
      },
    });
    const { interaction, replies } = fakeInteraction({ sub: "status" });
    await handleInterviewCommand(interaction, deps);
    expect(replies[0]?.content).toBe("コマンドの処理に失敗しました。");
    expect(replies[0]?.ephemeral).toBe(true);
  });
});
