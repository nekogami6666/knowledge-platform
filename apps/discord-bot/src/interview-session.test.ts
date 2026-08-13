import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./db.js";
import {
  createInterviewChunkBinding,
  findActiveInterviewSession,
  INTERVIEW_SESSION_ACTION_TYPE,
  type InterviewSessionPayload,
  interviewChunkSchema,
  interviewSessionPayloadSchema,
  parseInterviewSessionPayload,
} from "./interview-session.js";

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const NOW = new Date("2026-08-13T03:00:00Z"); // = 12:00 JST

function samplePayload(over: Partial<InterviewSessionPayload> = {}): InterviewSessionPayload {
  return {
    sessionId: "sess-1",
    person: "山田",
    topic: "リリース手順",
    kitPath: "interviews/kits/2026/x.md",
    guildId: "G1",
    channelId: "VC1",
    starterId: "U-starter",
    participantIds: [],
    chunks: [],
    currentChunk: null,
    startedAtJst: "2026-08-13T11:30:00+09:00", // NOW の 30 分前
    ...over,
  };
}

function seed(
  store = createMemoryStore(),
  state = "armed",
  payload: InterviewSessionPayload | string = samplePayload(),
) {
  store.queueAction({
    id: "act-1",
    type: INTERVIEW_SESSION_ACTION_TYPE,
    queryId: null,
    payloadJson: typeof payload === "string" ? payload : JSON.stringify(payload),
    state,
    createdAt: "t",
  });
  return store;
}

function mkBinding(store = createMemoryStore(), armTtlMinutes = 120) {
  const queued: number[] = [];
  const binding = createInterviewChunkBinding({
    store,
    now: () => NOW,
    armTtlMinutes,
    onQueued: () => queued.push(1),
    logger,
  });
  return { binding, store, queued };
}

const storedPayload = (store: ReturnType<typeof createMemoryStore>) =>
  interviewSessionPayloadSchema.parse(
    JSON.parse(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.payloadJson ?? ""),
  );

describe("interview セッション契約(ADR-0028 D1)", () => {
  it("チャンク・payload のスキーマは defaults を補完し、未知キーは拒否する(strict)", () => {
    const chunk = interviewChunkSchema.parse({
      seq: 1,
      meetingId: "vm-1",
      filePath: "/r/vm-1/recording.m4a",
      recordedAtJst: "2026-08-13T12:00:00+09:00",
    });
    expect(chunk.transcript).toBeNull();
    const payload = interviewSessionPayloadSchema.parse({
      sessionId: "s",
      person: "p",
      topic: "t",
      kitPath: null,
      guildId: "g",
      channelId: "c",
      starterId: "u",
      startedAtJst: "2026-08-13T12:00:00+09:00",
    });
    expect(payload.participantIds).toEqual([]);
    expect(payload.chunks).toEqual([]);
    expect(payload.currentChunk).toBeNull();
    expect(() =>
      interviewSessionPayloadSchema.parse({ ...samplePayload(), extra: true }),
    ).toThrow();
    expect(interviewChunkSchema.safeParse({ seq: 0, meetingId: "m" }).success).toBe(false);
  });

  it("parseInterviewSessionPayload は壊れた JSON / スキーマ違反 / null に null を返す", () => {
    expect(parseInterviewSessionPayload(null)).toBeNull();
    expect(parseInterviewSessionPayload("{oops")).toBeNull();
    expect(parseInterviewSessionPayload('{"sessionId":"s"}')).toBeNull();
    expect(parseInterviewSessionPayload(JSON.stringify(samplePayload()))?.sessionId).toBe("sess-1");
  });
});

describe("findActiveInterviewSession(ADR-0028 D1/D5)", () => {
  it("armed / recording を見つける(pending・done・cancelled は対象外)", () => {
    for (const state of ["armed", "recording"]) {
      const store = seed(createMemoryStore(), state);
      expect(findActiveInterviewSession(store, NOW, 120)?.state).toBe(state);
    }
    for (const state of ["pending", "done", "cancelled"]) {
      const store = seed(createMemoryStore(), state);
      expect(findActiveInterviewSession(store, NOW, 120)).toBeNull();
    }
  });

  it("armed が TTL 超過なら cancelled に落として null(lazy 失効)", () => {
    const store = seed(createMemoryStore(), "armed"); // 30 分前開始
    expect(findActiveInterviewSession(store, NOW, 10)).toBeNull();
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("cancelled");
  });

  it("recording は TTL の対象外(録音中は失効しない)", () => {
    const store = seed(createMemoryStore(), "recording");
    expect(findActiveInterviewSession(store, NOW, 10)?.state).toBe("recording");
  });

  it("壊れた payload は markActionDone で捨てて null(voice-pipeline の作法)", () => {
    const store = seed(createMemoryStore(), "armed", "{broken");
    expect(findActiveInterviewSession(store, NOW, 120)).toBeNull();
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("done");
  });
});

describe("createInterviewChunkBinding(ADR-0028 D1/D2)", () => {
  it("claimChunk: セッション無しなら null", () => {
    const { binding } = mkBinding();
    expect(binding.claimChunk("vm-1", "2026-08-13T12:00:00+09:00")).toBeNull();
  });

  it("claimChunk: armed セッションに currentChunk を永続化し recording へ進める", () => {
    const { binding, store } = mkBinding(seed());
    const claim = binding.claimChunk("vm-1", "2026-08-13T12:00:00+09:00");
    expect(claim).toEqual({ sessionActionId: "act-1", seq: 1 });
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("recording");
    expect(storedPayload(store).currentChunk).toEqual({ seq: 1, meetingId: "vm-1" });
  });

  it("claimChunk: TTL 失効した armed には claim しない(cancelled 化)", () => {
    const { binding, store } = mkBinding(seed(), 10); // 30 分前開始 > TTL 10 分
    expect(binding.claimChunk("vm-1", "2026-08-13T12:00:00+09:00")).toBeNull();
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("cancelled");
  });

  it("commitChunk: chunks 追記・currentChunk クリア・participantIds 和集合 → 次 claim は seq+1", () => {
    const { binding, store } = mkBinding(seed());
    const claim = binding.claimChunk("vm-1", "2026-08-13T12:00:00+09:00");
    if (claim === null) throw new Error("claim expected");
    binding.commitChunk(
      claim.sessionActionId,
      {
        seq: claim.seq,
        meetingId: "vm-1",
        filePath: "/r/vm-1/recording.m4a",
        recordedAtJst: "2026-08-13T12:15:00+09:00",
        transcript: null,
      },
      ["U1", "U2"],
    );
    let payload = storedPayload(store);
    expect(payload.chunks.map((c) => c.seq)).toEqual([1]);
    expect(payload.currentChunk).toBeNull();
    expect(payload.participantIds).toEqual(["U1", "U2"]);

    const claim2 = binding.claimChunk("vm-2", "2026-08-13T12:15:00+09:00");
    expect(claim2?.seq).toBe(2);
    binding.commitChunk(
      "act-1",
      {
        seq: 2,
        meetingId: "vm-2",
        filePath: "/r/vm-2/recording.m4a",
        recordedAtJst: "2026-08-13T12:30:00+09:00",
        transcript: null,
      },
      ["U2", "U3"], // U2 は重複 → 和集合
    );
    payload = storedPayload(store);
    expect(payload.chunks.map((c) => c.seq)).toEqual([1, 2]);
    expect(payload.participantIds).toEqual(["U1", "U2", "U3"]);
  });

  it("dropChunk: currentChunk をクリアするだけ(chunks は増えない = 欠番)", () => {
    const { binding, store } = mkBinding(seed());
    binding.claimChunk("vm-1", "2026-08-13T12:00:00+09:00");
    binding.dropChunk("act-1", "vm-1");
    const payload = storedPayload(store);
    expect(payload.currentChunk).toBeNull();
    expect(payload.chunks).toEqual([]);
    // meetingId が一致しない drop は no-op(古いチャンクの遅延 drop が現行を壊さない)。
    binding.claimChunk("vm-2", "2026-08-13T12:10:00+09:00");
    binding.dropChunk("act-1", "vm-1");
    expect(storedPayload(store).currentChunk?.meetingId).toBe("vm-2");
  });

  it("completeSession: チャンク有 → pending + onQueued / 0 件 → cancelled", () => {
    const withChunk = mkBinding(
      seed(
        createMemoryStore(),
        "recording",
        samplePayload({
          chunks: [
            {
              seq: 1,
              meetingId: "vm-1",
              filePath: "/r/vm-1/recording.m4a",
              recordedAtJst: "2026-08-13T12:00:00+09:00",
              transcript: null,
            },
          ],
        }),
      ),
    );
    withChunk.binding.completeSession("act-1");
    expect(withChunk.store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe(
      "pending",
    );
    expect(withChunk.queued).toHaveLength(1);

    const empty = mkBinding(seed(createMemoryStore(), "recording"));
    empty.binding.completeSession("act-1");
    expect(empty.store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe(
      "cancelled",
    );
    expect(empty.queued).toHaveLength(0);
  });

  it("resumeTarget: recording の 1 件を payload 付きで返す(armed / pending は対象外)", () => {
    const rec = mkBinding(
      seed(
        createMemoryStore(),
        "recording",
        samplePayload({
          currentChunk: { seq: 3, meetingId: "vm-3" },
        }),
      ),
    );
    expect(rec.binding.resumeTarget()?.payload.currentChunk).toEqual({
      seq: 3,
      meetingId: "vm-3",
    });
    expect(mkBinding(seed(createMemoryStore(), "armed")).binding.resumeTarget()).toBeNull();
    expect(mkBinding(seed(createMemoryStore(), "pending")).binding.resumeTarget()).toBeNull();
  });

  it("resumeTarget: 壊れた payload は markActionDone で捨てて null", () => {
    const { binding, store } = mkBinding(seed(createMemoryStore(), "recording", "{broken"));
    expect(binding.resumeTarget()).toBeNull();
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("done");
  });
});
