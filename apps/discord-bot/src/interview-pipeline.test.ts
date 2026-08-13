import type { GhClient } from "@stratum/gh-client";
import { GhClientError } from "@stratum/gh-client";
import type { Members } from "@stratum/kb-core";
import { LlmError, type Transcriber } from "@stratum/llm";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { OpsConfig } from "./config.js";
import type { BotStore, PendingAction } from "./db.js";
import {
  chunkPlaceholder,
  type InterviewPipelineDeps,
  interviewSessionBranch,
  processInterviewSessionQueue,
  SESSION_NO_AUDIO_MESSAGE,
} from "./interview-pipeline.js";
import type { InterviewChunk, InterviewSessionPayload } from "./interview-session.js";
import { interviewSessionPayloadSchema } from "./interview-session.js";

const OPS: OpsConfig = { channel_id: "OPS", kb_repo: "org/knowledge-base" };
const MEMBERS: Members = {
  members: [
    { github: "yamada", discord: "U-yamada", name: "山田" },
    { github: "suzuki", discord: "U-starter", name: "鈴木" },
  ],
};
const NOW = new Date("2026-08-13T03:00:00Z"); // = 12:00 JST

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function chunk(seq: number, over: Partial<InterviewChunk> = {}): InterviewChunk {
  return {
    seq,
    meetingId: `vm-${seq}`,
    filePath: `/recordings/vm-${seq}/recording.m4a`,
    recordedAtJst: "2026-08-13T11:00:00+09:00",
    transcript: null,
    ...over,
  };
}

function sessionPayload(over: Partial<InterviewSessionPayload> = {}): InterviewSessionPayload {
  return {
    sessionId: "sess-abc123",
    person: "山田",
    topic: "リリース手順",
    kitPath: "interviews/kits/x-x.md",
    guildId: "G1",
    channelId: "VC1",
    starterId: "U-starter",
    participantIds: ["U-yamada", "U-unknown"],
    chunks: [chunk(1), chunk(2)],
    currentChunk: null,
    startedAtJst: "2026-08-13T11:00:00+09:00",
    ...over,
  };
}

function pendingAction(payload: InterviewSessionPayload = sessionPayload()): PendingAction {
  return {
    id: "ACT1",
    type: "interview_session",
    queryId: null,
    payloadJson: JSON.stringify(payload),
    state: "pending",
    createdAt: "2026-08-13T11:00:00+09:00",
  };
}

function fakeStore(actions: PendingAction[]): {
  store: BotStore;
  done: string[];
  payloads: string[];
} {
  const done: string[] = [];
  const payloads: string[] = [];
  const store = {
    listPendingActions: vi.fn((type?: string) =>
      actions.filter((a) => type === undefined || a.type === type),
    ),
    markActionDone: vi.fn((id: string) => {
      done.push(id);
    }),
    setActionPayload: vi.fn((_id: string, json: string) => {
      payloads.push(json);
    }),
  };
  return { store: store as unknown as BotStore, done, payloads };
}

function fakeGh(opts: { existingHead?: string; createThrows?: unknown } = {}): {
  gh: GhClient;
  created: {
    head: string;
    title: string;
    body: string;
    files: { path: string; content: string }[];
  }[];
} {
  const created: {
    head: string;
    title: string;
    body: string;
    files: { path: string; content: string }[];
  }[] = [];
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
    createPullRequest: vi.fn(async (o: never) => {
      if (opts.createThrows !== undefined) throw opts.createThrows;
      created.push(o);
      return { number: 9, url: "https://github.com/org/knowledge-base/pull/9" };
    }),
  } as unknown as GhClient;
  return { gh, created };
}

function fakeMessenger(): {
  messenger: InterviewPipelineDeps["messenger"];
  dms: { userId: string; content: string }[];
} {
  const dms: { userId: string; content: string }[] = [];
  return {
    dms,
    messenger: {
      reply: async () => {
        throw new Error("interview pipeline はスレッド返信しない(DM のみ)");
      },
      dm: async (userId, content) => {
        dms.push({ userId, content });
      },
    },
  };
}

const transcriberBySeq =
  (texts: Record<string, string>): Transcriber =>
  async ({ audio }) => {
    const key = new TextDecoder().decode(audio);
    const text = texts[key];
    if (text === undefined) throw new Error(`unexpected audio: ${key}`);
    return { text, model: "gpt-4o-transcribe" };
  };

/** readLocalFile: ファイル内容 = meetingId(transcriberBySeq のキー)。 */
const readByMeetingId = async (path: string): Promise<Uint8Array> => {
  const m = /\/(vm-\d+)\//.exec(path);
  if (m === null) throw new Error(`ENOENT: ${path}`);
  return new TextEncoder().encode(m[1]);
};

function mkDeps(over: Partial<InterviewPipelineDeps> = {}): InterviewPipelineDeps {
  const { store } = fakeStore([pendingAction()]);
  const { gh } = fakeGh();
  const { messenger } = fakeMessenger();
  return {
    logger,
    store,
    getMembers: async () => MEMBERS,
    ops: OPS,
    gh,
    transcriber: transcriberBySeq({ "vm-1": "前半の話。", "vm-2": "後半の話。" }),
    messenger,
    readLocalFile: readByMeetingId,
    now: () => NOW,
    ...over,
  };
}

describe("interviewSessionBranch", () => {
  it("interview/<sessionId>(冪等キー)", () => {
    expect(interviewSessionBranch("sess-abc123")).toBe("interview/sess-abc123");
  });
});

describe("processInterviewSessionQueue(ADR-0028 D4)", () => {
  it("機能に必要な依存(kb_repo / gh / transcriber)が無ければ何もしない(pending は残る)", async () => {
    const { store } = fakeStore([pendingAction()]);
    const listSpy = store.listPendingActions as ReturnType<typeof vi.fn>;
    await processInterviewSessionQueue(mkDeps({ store, gh: undefined }));
    await processInterviewSessionQueue(mkDeps({ store, transcriber: undefined }));
    await processInterviewSessionQueue(
      mkDeps({ store, ops: { channel_id: "OPS", kb_repo: null } }),
    );
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("STT を seq 順に結合して原本 1 ファイルの単発 PR を作り、starter へ DM して done にする", async () => {
    const { store, done, payloads } = fakeStore([pendingAction()]);
    const { gh, created } = fakeGh();
    const { messenger, dms } = fakeMessenger();
    await processInterviewSessionQueue(mkDeps({ store, gh, messenger }));

    expect(created).toHaveLength(1);
    const pr = created[0] as (typeof created)[number];
    expect(pr.head).toBe("interview/sess-abc123");
    expect(pr.title).toBe("docs(kb): インタビュー 山田 × リリース手順(セッション原本)");
    expect(pr.body).toContain("`interviews/kits/x-x.md`");
    expect(pr.body).toContain("マージ後、夜間の extractor が複数ナレッジ記事に自動分割します");

    // 原本のみ(草案なし)。パスは kb-core の interviewSessionPath 規約。
    expect(pr.files).toHaveLength(1);
    const file = pr.files[0] as { path: string; content: string };
    expect(file.path).toBe("interviews/sessions/2026/2026-08-13-x-x-sessab.md");
    expect(file.content).toContain("前半の話。\n\n後半の話。");
    // 参加者 = participantIds ∪ {starterId} の表示名(未登載は生 ID)。
    expect(file.content).toContain("参加者: 山田, U-unknown, 鈴木");
    expect(file.content).toContain("gpt-4o-transcribe(チャンク 2 本・自動分割)");
    expect(file.content).toContain("https://discord.com/channels/G1/VC1");

    // STT 成功のたびに payload へキャッシュ(2 チャンク = 2 回)。
    expect(payloads).toHaveLength(2);
    const cached = interviewSessionPayloadSchema.parse(JSON.parse(payloads[1] ?? ""));
    expect(cached.chunks.map((c) => c.transcript)).toEqual(["前半の話。", "後半の話。"]);
    expect(cached.chunks[0]?.sttModel).toBe("gpt-4o-transcribe");

    expect(dms).toHaveLength(1);
    expect(dms[0]?.userId).toBe("U-starter");
    expect(dms[0]?.content).toContain("https://github.com/org/knowledge-base/pull/9");
    expect(dms[0]?.content).toContain("👍");
    expect(dms[0]?.content).toContain("複数のナレッジ記事に自動分割");
    expect(done).toEqual(["ACT1"]);
  });

  it("冪等: 同 branch の PR(state:all)が既にあれば作り直さず done にする", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh, created } = fakeGh({ existingHead: "interview/sess-abc123" });
    const transcriber = vi.fn() as unknown as Transcriber;
    await processInterviewSessionQueue(mkDeps({ store, gh, transcriber }));
    expect(created).toHaveLength(0);
    expect(transcriber).not.toHaveBeenCalled();
    expect(done).toEqual(["ACT1"]);
  });

  it("chunks 空は starter に「録音を取得できませんでした」を DM して done にする", async () => {
    const { store, done } = fakeStore([pendingAction(sessionPayload({ chunks: [] }))]);
    const { gh, created } = fakeGh();
    const { messenger, dms } = fakeMessenger();
    await processInterviewSessionQueue(mkDeps({ store, gh, messenger }));
    expect(dms).toEqual([{ userId: "U-starter", content: SESSION_NO_AUDIO_MESSAGE }]);
    expect(created).toHaveLength(0);
    expect(done).toEqual(["ACT1"]);
  });

  it("transcript キャッシュ済みチャンクは再 STT しない", async () => {
    const { store, payloads } = fakeStore([
      pendingAction(
        sessionPayload({
          chunks: [
            chunk(1, { transcript: "キャッシュ済みの前半。", sttModel: "gpt-4o-transcribe" }),
            chunk(2),
          ],
        }),
      ),
    ]);
    const transcriber = vi.fn(async () => ({ text: "後半の話。", model: "gpt-4o-transcribe" }));
    const { gh, created } = fakeGh();
    await processInterviewSessionQueue(
      mkDeps({ store, gh, transcriber: transcriber as unknown as Transcriber }),
    );
    expect(transcriber).toHaveBeenCalledTimes(1); // seq 2 のみ
    expect(payloads).toHaveLength(1);
    const content = (created[0]?.files[0] as { content: string }).content;
    expect(content).toContain("キャッシュ済みの前半。\n\n後半の話。");
  });

  it("ファイル欠落チャンクはプレースホルダで本文に明示して続行する", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh, created } = fakeGh();
    const read = async (path: string): Promise<Uint8Array> => {
      if (path.includes("vm-1")) throw new Error("ENOENT");
      return readByMeetingId(path);
    };
    await processInterviewSessionQueue(mkDeps({ store, gh, readLocalFile: read }));
    const content = (created[0]?.files[0] as { content: string }).content;
    expect(content).toContain(`${chunkPlaceholder(1)}\n\n後半の話。`);
    expect(done).toEqual(["ACT1"]);
  });

  it("STT の恒久失敗もプレースホルダで続行する", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh, created } = fakeGh();
    const transcriber: Transcriber = async ({ audio }) => {
      if (new TextDecoder().decode(audio) === "vm-1") throw new LlmError("API_ERROR", "400");
      return { text: "後半の話。", model: "gpt-4o-transcribe" };
    };
    await processInterviewSessionQueue(mkDeps({ store, gh, transcriber }));
    const content = (created[0]?.files[0] as { content: string }).content;
    expect(content).toContain(`${chunkPlaceholder(1)}\n\n後半の話。`);
    expect(done).toEqual(["ACT1"]);
  });

  it("STT の一時的失敗は pending を残す(成功済みチャンクのキャッシュは保持)", async () => {
    const { store, done, payloads } = fakeStore([pendingAction()]);
    const { gh, created } = fakeGh();
    const transcriber: Transcriber = async ({ audio }) => {
      if (new TextDecoder().decode(audio) === "vm-2") throw new LlmError("RATE_LIMITED", "429");
      return { text: "前半の話。", model: "gpt-4o-transcribe" };
    };
    await processInterviewSessionQueue(mkDeps({ store, gh, transcriber }));
    expect(created).toHaveLength(0);
    expect(done).toEqual([]); // pending のまま(次回 kick で seq 2 だけ再試行)
    expect(payloads).toHaveLength(1); // seq 1 はキャッシュ済み
    const cached = interviewSessionPayloadSchema.parse(JSON.parse(payloads[0] ?? ""));
    expect(cached.chunks[0]?.transcript).toBe("前半の話。");
  });

  it("PR 作成の CONFLICT(ブランチ既存)は冪等扱いで done にする", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh } = fakeGh({ createThrows: new GhClientError("CONFLICT", "exists") });
    await processInterviewSessionQueue(mkDeps({ store, gh }));
    expect(done).toEqual(["ACT1"]);
  });

  it("PR 作成の一時的失敗は pending を残す", async () => {
    const { store, done } = fakeStore([pendingAction()]);
    const { gh } = fakeGh({ createThrows: new LlmError("OVERLOADED", "529") });
    await processInterviewSessionQueue(mkDeps({ store, gh }));
    expect(done).toEqual([]);
  });

  it("壊れた payload は done にして飛ばす(再試行しても直らない)", async () => {
    const { store, done } = fakeStore([
      { ...pendingAction(), payloadJson: "{broken" },
      { ...pendingAction(), id: "ACT2", payloadJson: null },
    ]);
    const { gh, created } = fakeGh();
    await processInterviewSessionQueue(mkDeps({ store, gh }));
    expect(created).toHaveLength(0);
    expect(done).toEqual(["ACT1", "ACT2"]);
  });
});
