import type { GhClient } from "@stratum/gh-client";
import { GhClientError } from "@stratum/gh-client";
import type { Members } from "@stratum/kb-core";
import type { PromptStore } from "@stratum/llm";
import { LlmError, type Transcriber } from "@stratum/llm";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { TRANSIENT_RETRY_MESSAGE } from "./ack.js";
import type { CaptureCandidate, DraftSearchFn } from "./capture.js";
import type { OpsConfig } from "./config.js";
import type { BotStore, PendingAction } from "./db.js";
import type { VoiceMemoPayload } from "./voice.js";
import {
  processVoiceMemoQueue,
  type VoicePipelineDeps,
  voiceMemoBranch,
} from "./voice-pipeline.js";

const OPS: OpsConfig = { channel_id: "OPS", kb_repo: "org/knowledge-base" };
const MEMBERS: Members = { members: [{ github: "yamada", discord: "U1" }] };
// permalink は数値 snowflake 必須(kb-core の discordSourceSchema)。
const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const MSG_ID = "333333333333333333";

function payload(over: Partial<VoiceMemoPayload> = {}): VoiceMemoPayload {
  return {
    messageId: MSG_ID,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    authorId: "U1",
    messageUrl: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MSG_ID}`,
    attachmentUrl: "https://cdn.discordapp.com/attachments/1/2/memo.ogg",
    attachmentName: "memo.ogg",
    contentType: "audio/ogg",
    size: 1024,
    ...over,
  };
}

function pendingAction(p: VoiceMemoPayload = payload()): PendingAction {
  return {
    id: "ACT1",
    type: "voice_memo",
    queryId: null,
    payloadJson: JSON.stringify(p),
    state: "pending",
    createdAt: "2026-07-08T10:00:00+09:00",
  };
}

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

function fakeStore(actions: PendingAction[]): { store: BotStore; done: string[] } {
  const done: string[] = [];
  const rateCounts = new Map<string, number>();
  const store = {
    listPendingActions: vi.fn((type?: string) =>
      actions.filter((a) => type === undefined || a.type === type),
    ),
    markActionDone: vi.fn((id: string) => {
      done.push(id);
    }),
    // 失敗通知の 1日1回抑制(ADR-0030 D3)。テストでは 1 回だけ通す実挙動を再現する。
    hitRateLimit: vi.fn((subject: string, kind: string, window: string, limit: number) => {
      const key = `${subject}|${kind}|${window}`;
      const count = (rateCounts.get(key) ?? 0) + 1;
      rateCounts.set(key, count);
      return { count, allowed: count <= limit };
    }),
  };
  return { store: store as unknown as BotStore, done };
}

function fakeGh(opts: { existingHead?: string; createThrows?: unknown } = {}): {
  gh: GhClient;
  created: { head: string; files: { path: string; content: string }[] }[];
} {
  const created: { head: string; files: { path: string; content: string }[] }[] = [];
  const gh = {
    listPullRequests: vi.fn(async () =>
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
    ),
    // counter は読まなくなった(乱数採番・ADR-0026)。getFileContents 経由の呼び出しがあれば落とす。
    getFileContents: vi.fn(async () => {
      throw new Error("voice-memo PR は id-counter を読まない(ADR-0026)");
    }),
    createPullRequest: vi.fn(async (o: { head: string; files: never }) => {
      if (opts.createThrows !== undefined) throw opts.createThrows;
      created.push(o as never);
      return { number: 7, url: "https://github.com/org/knowledge-base/pull/7" };
    }),
  } as unknown as GhClient;
  return { gh, created };
}

function fakeMessenger(): {
  messenger: VoicePipelineDeps["messenger"];
  replies: string[];
  dms: string[];
  reactions: string[];
  dmThrows?: boolean;
} {
  const replies: string[] = [];
  const dms: string[] = [];
  const reactions: string[] = [];
  const messenger = {
    reply: async (_c: string, _m: string, content: string) => {
      replies.push(content);
    },
    dm: async (_u: string, content: string) => {
      dms.push(content);
    },
    react: async (_c: string, _m: string, emoji: string) => {
      reactions.push(emoji);
    },
  };
  return { messenger, replies, dms, reactions };
}

const candidate: CaptureCandidate = {
  title: "分注ユニット X 軸の給脂は月イチ",
  entryType: "procedure",
  domain: "hardware",
  body: "X 軸は月イチで給脂する。",
  confidence: "medium",
};

const draftFixed: DraftSearchFn = async () => ({
  value: candidate,
  usage: { inputTokens: 1, outputTokens: 1 },
});

const transcriberFixed: Transcriber = async () => ({
  text: "分注ユニットの X 軸は月イチで給脂が必要。",
  model: "gpt-4o-transcribe",
});

const promptStore: PromptStore = {
  read: async () => "---\nrole: standard\n---\nDRAFT RULES",
} as PromptStore;

const okFetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as never;

function mkDeps(over: Partial<VoicePipelineDeps> = {}): VoicePipelineDeps {
  const { logger } = fakeLogger();
  const { store } = fakeStore([pendingAction()]);
  const { gh } = fakeGh();
  const { messenger } = fakeMessenger();
  return {
    logger,
    store,
    getMembers: async () => MEMBERS,
    ops: OPS,
    gh,
    promptStore,
    cwd: ".",
    transcriber: transcriberFixed,
    messenger,
    fetchFn: okFetch,
    draftSearch: draftFixed,
    // 決定的スタブ(既定は kb-core newId の乱数採番・ADR-0026)。1テスト1採番なので固定値。
    makeId: (kind) => `${kind}-2026-abc123`,
    now: () => new Date("2026-07-08T01:00:00Z"), // JST 10:00
    ...over,
  };
}

describe("voiceMemoBranch", () => {
  it("voice-memo/<messageId>(冪等キー)", () => {
    expect(voiceMemoBranch("MSG1")).toBe("voice-memo/MSG1");
  });
});

describe("processVoiceMemoQueue", () => {
  it("原本 + 記事を 1 PR に同梱し(id-counter は同梱しない)、スレッド返信 + DM して done にする", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh, created } = fakeGh();
    const { messenger, replies, dms } = fakeMessenger();
    await processVoiceMemoQueue(mkDeps({ store, gh, messenger }));

    expect(created).toHaveLength(1);
    const pr = created[0] as (typeof created)[number];
    expect(pr.head).toBe(`voice-memo/${MSG_ID}`);
    const paths = pr.files.map((f) => f.path);
    expect(paths).toEqual([
      `interviews/voice-memos/2026/2026-07-08-${MSG_ID}.md`,
      expect.stringMatching(/^knowledge\/hardware\/kb-2026-abc123.*\.md$/),
    ]);
    expect(paths).not.toContain("_meta/id-counter.json");
    // 原本は無加工(P1)+ 来歴
    const doc = (pr.files[0] as { content: string }).content;
    expect(doc).toContain("分注ユニットの X 軸は月イチで給脂が必要。");
    expect(doc).toContain("gpt-4o-transcribe");
    // 記事の出典 = voice-memo(原本パス)+ discord permalink(P2)
    const entry = (pr.files[1] as { content: string }).content;
    expect(entry).toContain('kind: "voice-memo"');
    expect(entry).toContain(`interviews/voice-memos/2026/2026-07-08-${MSG_ID}.md`);
    expect(entry).toContain('kind: "discord"');
    expect(entry).toContain('owner: "yamada"');

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("こう記録しました");
    expect(replies[0]).toContain("https://github.com/org/knowledge-base/pull/7");
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("👍");
    expect(done).toEqual(["ACT1"]);
  });

  it("transcriber 未設定(機能 OFF)は何もしない(pending は残る)", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const deps = mkDeps({ store });
    delete (deps as { transcriber?: unknown }).transcriber;
    await processVoiceMemoQueue(deps);
    expect(done).toHaveLength(0);
    expect(store.listPendingActions).not.toHaveBeenCalled();
  });

  it("既存 PR(同一ブランチ)があれば作り直さず done にする(冪等)", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh, created } = fakeGh({ existingHead: `voice-memo/${MSG_ID}` });
    const transcriber = vi.fn(transcriberFixed);
    await processVoiceMemoQueue(mkDeps({ store, gh, transcriber }));
    expect(created).toHaveLength(0);
    expect(transcriber).not.toHaveBeenCalled();
    expect(done).toEqual(["ACT1"]);
  });

  it("添付 DL の 4xx(URL 失効)は案内を返信して done(恒久失敗)", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { messenger, replies } = fakeMessenger();
    const fetch404 = (async () => new Response("gone", { status: 404 })) as never;
    await processVoiceMemoQueue(mkDeps({ store, messenger, fetchFn: fetch404 }));
    expect(replies).toHaveLength(1);
    expect(done).toEqual(["ACT1"]);
  });

  it("STT の一時的失敗(429 等)は返信せず pending を残す(次回再試行)", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { messenger, replies } = fakeMessenger();
    const transcriber: Transcriber = async () => {
      throw new LlmError("RATE_LIMITED", "429");
    };
    await processVoiceMemoQueue(mkDeps({ store, messenger, transcriber }));
    expect(replies).toHaveLength(0);
    expect(done).toHaveLength(0);
  });

  it("STT の恒久失敗(API_ERROR)は案内を返信して done", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { messenger, replies } = fakeMessenger();
    const transcriber: Transcriber = async () => {
      throw new LlmError("API_ERROR", "400");
    };
    await processVoiceMemoQueue(mkDeps({ store, messenger, transcriber }));
    expect(replies).toHaveLength(1);
    expect(done).toEqual(["ACT1"]);
  });

  it("空の文字起こしは案内を返信して done", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { messenger, replies } = fakeMessenger();
    const transcriber: Transcriber = async () => ({ text: "  ", model: "gpt-4o-transcribe" });
    await processVoiceMemoQueue(mkDeps({ store, messenger, transcriber }));
    expect(replies).toHaveLength(1);
    expect(done).toEqual(["ACT1"]);
  });

  it("PR 作成の CONFLICT(同時二重処理)は冪等扱いで done", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh } = fakeGh({ createThrows: new GhClientError("CONFLICT", "branch exists") });
    await processVoiceMemoQueue(mkDeps({ store, gh }));
    expect(done).toEqual(["ACT1"]);
  });

  it("一時的失敗は ⏳ と「自動的に再試行します」を返して pending を残す(ADR-0030 D3)", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh } = fakeGh({ createThrows: new LlmError("OVERLOADED", "529") });
    const { messenger, dms, reactions } = fakeMessenger();
    await processVoiceMemoQueue(mkDeps({ store, gh, messenger }));
    expect(done).toEqual([]); // pending のまま(次回 kick で再試行)
    expect(reactions).toEqual(["⏳"]);
    expect(dms).toEqual([TRANSIENT_RETRY_MESSAGE]);
  });

  it("同じ処理の失敗通知は 1日1回だけ(再試行のたびに連投しない)", async () => {
    const { store } = fakeStore([pendingAction()]);
    const { gh } = fakeGh({ createThrows: new LlmError("OVERLOADED", "529") });
    const { messenger, dms } = fakeMessenger();
    await processVoiceMemoQueue(mkDeps({ store, gh, messenger }));
    await processVoiceMemoQueue(mkDeps({ store, gh, messenger }));
    expect(dms).toHaveLength(1);
  });

  it("想定外の恒久失敗は ⚠️ と理由を返す(無言で pending に沈めない)", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh } = fakeGh({ createThrows: new Error("boom") });
    const { messenger, dms, reactions } = fakeMessenger();
    await processVoiceMemoQueue(mkDeps({ store, gh, messenger }));
    expect(done).toEqual([]);
    expect(reactions).toEqual(["⚠️"]);
    expect(dms).toEqual(["処理できませんでした: boom"]);
  });

  it("壊れた payload は done にして飛ばす(再試行しても直らない)", async () => {
    const broken: PendingAction = { ...pendingAction(), payloadJson: JSON.stringify({ x: 1 }) };
    const { store, done } = fakeStore([broken]);
    const { gh, created } = fakeGh();
    await processVoiceMemoQueue(mkDeps({ store, gh }));
    expect(created).toHaveLength(0);
    expect(done).toEqual(["ACT1"]);
  });

  it("DM 失敗(受信拒否)はスレッド返信にフォールバックして done(ADR-0030 D2)", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const replies: string[] = [];
    const messenger = {
      reply: async (_c: string, _m: string, content: string) => {
        replies.push(content);
      },
      dm: async () => {
        throw new Error("Cannot send messages to this user");
      },
    };
    await processVoiceMemoQueue(mkDeps({ store, messenger }));
    // 1本目 = 「こう記録しました」、2本目 = DM が届かなかった旨を添えた PR 案内。
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("DM を送れませんでした");
    expect(replies[1]).toContain("https://github.com/org/knowledge-base/pull/7");
    expect(done).toEqual(["ACT1"]);
  });
});

// --- 訂正フライホイール(PR-V4)------------------------------------------------

import { buildVoiceMemoDoc } from "@stratum/kb-core";
import type { VoiceCorrectionPayload } from "./voice.js";
import {
  type CorrectionSearchFn,
  processVoiceCorrectionQueue,
  type VoiceCorrectionResult,
} from "./voice-pipeline.js";

const TRANSCRIPT_PATH = `interviews/voice-memos/2026/2026-07-08-${MSG_ID}.md`;
const CURRENT_DOC = buildVoiceMemoDoc({
  transcript: "給脂は月イチで行う。",
  messageUrl: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MSG_ID}`,
  author: "yamada",
  dateJst: "2026-07-08",
  sttModel: "gpt-4o-transcribe",
});

function correctionPayload(over: Partial<VoiceCorrectionPayload> = {}): VoiceCorrectionPayload {
  return {
    originalMessageId: MSG_ID,
    prNumber: 7,
    transcriptPath: TRANSCRIPT_PATH,
    correction: "月イチではなく週イチです",
    channelId: CHANNEL_ID,
    correctionMessageId: "444444444444444444",
    correctorId: "U1",
    ...over,
  };
}

function correctionAction(p: VoiceCorrectionPayload = correctionPayload()): PendingAction {
  return {
    id: "CORR-ACT1",
    type: "voice_correction",
    queryId: null,
    payloadJson: JSON.stringify(p),
    state: "pending",
    createdAt: "2026-07-08T11:00:00+09:00",
  };
}

function fakeCorrectionGh(
  opts: { prState?: string; merged?: boolean; commitThrows?: unknown; fileMissing?: boolean } = {},
): { gh: GhClient; commits: { branch: string; files: { path: string; content: string }[] }[] } {
  const commits: { branch: string; files: { path: string; content: string }[] }[] = [];
  const gh = {
    getPullRequest: vi.fn(async () => ({
      number: 7,
      state: opts.prState ?? "open",
      merged: opts.merged ?? false,
      mergeableState: "clean",
      title: "t",
      url: "https://github.com/org/knowledge-base/pull/7",
    })),
    getFileContents: vi.fn(async () =>
      opts.fileMissing === true ? null : { content: CURRENT_DOC, sha: "S" },
    ),
    commitFiles: vi.fn(async (o: { branch: string; files: never }) => {
      if (opts.commitThrows !== undefined) throw opts.commitThrows;
      commits.push(o as never);
      return { sha: "C" };
    }),
  } as unknown as GhClient;
  return { gh, commits };
}

const correctionFixed: CorrectionSearchFn = async () => ({
  value: { transcript: "給脂は週イチで行う。" } satisfies VoiceCorrectionResult,
  usage: { inputTokens: 1, outputTokens: 1 },
});

describe("processVoiceCorrectionQueue", () => {
  it("open PR のブランチ上の原本に訂正を反映し、✅ 返信して done", async () => {
    const { store, done } = fakeStore([correctionAction()]);
    const { gh, commits } = fakeCorrectionGh();
    const { messenger, replies } = fakeMessenger();
    await processVoiceCorrectionQueue(
      mkDeps({ store, gh, messenger, correctionSearch: correctionFixed }),
    );

    expect(commits).toHaveLength(1);
    const commit = commits[0] as (typeof commits)[number];
    expect(commit.branch).toBe(`voice-memo/${MSG_ID}`);
    const file = commit.files[0] as { path: string; content: string };
    expect(file.path).toBe(TRANSCRIPT_PATH);
    expect(file.content).toContain("## 文字起こし\n\n給脂は週イチで行う。");
    expect(file.content).toContain("# Voice memo 2026-07-08(yamada)"); // ヘッダは保持
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("✅");
    expect(done).toEqual(["CORR-ACT1"]);
  });

  it("マージ/クローズ済み PR には反映せず案内して done(初期スコープ)", async () => {
    const { store, done } = fakeStore([correctionAction()]);
    const { gh, commits } = fakeCorrectionGh({ merged: true, prState: "closed" });
    const { messenger, replies } = fakeMessenger();
    await processVoiceCorrectionQueue(
      mkDeps({ store, gh, messenger, correctionSearch: correctionFixed }),
    );
    expect(commits).toHaveLength(0);
    expect(replies[0]).toContain("マージ/クローズ済み");
    expect(done).toEqual(["CORR-ACT1"]);
  });

  it("ブランチ更新の CONFLICT(手編集と競合)は案内して done", async () => {
    const { store, done } = fakeStore([correctionAction()]);
    const { gh } = fakeCorrectionGh({
      commitThrows: new GhClientError("CONFLICT", "non-fast-forward"),
    });
    const { messenger, replies } = fakeMessenger();
    await processVoiceCorrectionQueue(
      mkDeps({ store, gh, messenger, correctionSearch: correctionFixed }),
    );
    expect(replies[0]).toContain("直接編集");
    expect(done).toEqual(["CORR-ACT1"]);
  });

  it("LLM の一時的失敗は pending を残す(次回再試行)", async () => {
    const { store, done } = fakeStore([correctionAction()]);
    const { gh, commits } = fakeCorrectionGh();
    const failing: CorrectionSearchFn = async () => {
      throw new LlmError("OVERLOADED", "529");
    };
    await processVoiceCorrectionQueue(mkDeps({ store, gh, correctionSearch: failing }));
    expect(commits).toHaveLength(0);
    expect(done).toHaveLength(0);
  });

  it("原本が見つからない場合は案内して done", async () => {
    const { store, done } = fakeStore([correctionAction()]);
    const { gh } = fakeCorrectionGh({ fileMissing: true });
    const { messenger, replies } = fakeMessenger();
    await processVoiceCorrectionQueue(
      mkDeps({ store, gh, messenger, correctionSearch: correctionFixed }),
    );
    expect(replies).toHaveLength(1);
    expect(done).toEqual(["CORR-ACT1"]);
  });
});

// --- VC 録音入口(ADR-0020・PR-V7)---

function vcPendingAction(): PendingAction {
  const p = {
    source: "vc" as const,
    meetingId: `vm-1700000000000-${CHANNEL_ID}`,
    filePath: `/recordings/vm-1700000000000-${CHANNEL_ID}/recording.m4a`,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    authorId: "U1",
    participantIds: ["U1", "U9"], // U9 は members 未登載 → people から除外される
    recordedAtJst: "2026-07-17T10:00:00+09:00",
  };
  return {
    id: "VC1",
    type: "voice_memo",
    queryId: null,
    payloadJson: JSON.stringify(p),
    state: "pending",
    createdAt: "2026-07-17T10:00:00+09:00",
  };
}

describe('processVoiceMemoQueue(VC 録音・source:"vc")', () => {
  it("共有マウントのファイルを読んで PR + DM(スレッド返信なし・出典は原本のみ・people 写像)", async () => {
    const { store, done } = fakeStore([vcPendingAction()]);
    const { gh, created } = fakeGh();
    const { messenger, replies, dms } = fakeMessenger();
    const reads: string[] = [];
    await processVoiceMemoQueue(
      mkDeps({
        store,
        gh,
        messenger,
        fetchFn: (async () => {
          throw new Error("fetch must not be called for vc");
        }) as never,
        readLocalFile: async (p) => {
          reads.push(p);
          return new Uint8Array([1, 2, 3]);
        },
      }),
    );
    expect(reads).toEqual([`/recordings/vm-1700000000000-${CHANNEL_ID}/recording.m4a`]);
    expect(created).toHaveLength(1);
    expect(created[0]?.head).toBe(`voice-memo/vm-1700000000000-${CHANNEL_ID}`);
    const entry = created[0]?.files.find((f) => f.path.startsWith("knowledge/"));
    expect(entry?.content).toContain('kind: "voice-memo"');
    expect(entry?.content).not.toContain('kind: "discord"');
    expect(entry?.content).toContain('"yamada"'); // people(U9 は未登載のため除外)
    expect(replies).toEqual([]); // 返信先メッセージが無い
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("VC 録音");
    expect(dms[0]).toContain("pull/7");
    expect(done).toEqual(["VC1"]);
  });

  it("録音ファイル欠落は恒久失敗として DM 案内 + done(PR を作らない)", async () => {
    const { store, done } = fakeStore([vcPendingAction()]);
    const { gh, created } = fakeGh();
    const { messenger, dms } = fakeMessenger();
    await processVoiceMemoQueue(
      mkDeps({
        store,
        gh,
        messenger,
        readLocalFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(created).toHaveLength(0);
    expect(dms).toHaveLength(1);
    expect(done).toEqual(["VC1"]);
  });
});
