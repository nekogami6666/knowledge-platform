import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./db.js";
import type {
  InterviewChunk,
  InterviewChunkBinding,
  InterviewSessionPayload,
} from "./interview-session.js";
import {
  createRecorderClient,
  createVcRecorderWatcher,
  RECORDING_FAILED_MESSAGE,
  type RecorderClient,
  type RecorderHandle,
  type VcRecorderDeps,
  vcSessionDecision,
} from "./vc-recorder.js";
import { VOICE_MEMO_ACTION_TYPE, voiceMemoPayloadSchema } from "./voice.js";

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;
const VC = "222222222222222222";
const NOW = new Date("2026-07-17T01:00:00Z");

describe("vcSessionDecision(ADR-0020 D3)", () => {
  it("セッション無 + 1 人以上 → start(複数人同時入室でも start)", () => {
    expect(vcSessionDecision(false, 1)).toBe("start");
    expect(vcSessionDecision(false, 3)).toBe("start");
  });
  it("セッション有 + 0 人 → finalize / 1 人以上 → noop(2 人目でも継続)", () => {
    expect(vcSessionDecision(true, 0)).toBe("finalize");
    expect(vcSessionDecision(true, 1)).toBe("noop");
    expect(vcSessionDecision(true, 2)).toBe("noop");
  });
  it("セッション無 + 0 人 → noop", () => {
    expect(vcSessionDecision(false, 0)).toBe("noop");
  });
});

describe("createRecorderClient(sidecar HTTP 契約)", () => {
  it("start は record の 4 フィールドを POST し、status は GET する", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const client = createRecorderClient("http://recorder:9488/", (async (
      url: string,
      init?: { body?: string },
    ) => {
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "recording", file_path: "/r/x/recording.m4a" }),
      };
    }) as never);
    const record = {
      meeting_id: "vm-1",
      guild_id: "G",
      voice_channel_id: VC,
      local_root_dir: "/recordings/vm-1",
    };
    await client.start(record);
    await client.status("vm-1");
    expect(calls[0]?.url).toBe("http://recorder:9488/recordings/start");
    expect((calls[0]?.body as { record: unknown }).record).toEqual(record);
    expect(calls[1]?.url).toBe("http://recorder:9488/recordings/status/vm-1");
  });
  it("HTTP エラーは throw(呼び手が失敗案内)", async () => {
    const client = createRecorderClient("http://r", (async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as never);
    await expect(client.status("x")).rejects.toThrow("503");
  });
});

// --- watcher ---

function fakeClient(handles: {
  finalizeStatus?: RecorderHandle["status"];
  statusSeq?: RecorderHandle["status"][];
  participantIds?: string[];
  startThrows?: boolean;
  finalizeThrows?: boolean;
}): {
  client: RecorderClient;
  startCalls: string[];
  finalizeCalls: string[];
  abortCalls: string[];
} {
  const startCalls: string[] = [];
  const finalizeCalls: string[] = [];
  const abortCalls: string[] = [];
  const seq = [...(handles.statusSeq ?? ["ok"])];
  const handle = (status: RecorderHandle["status"]): RecorderHandle => ({
    status,
    file_path: "/recordings/m/recording.m4a",
    participant_ids: handles.participantIds ?? ["U1"],
  });
  return {
    startCalls,
    finalizeCalls,
    abortCalls,
    client: {
      async start(r) {
        if (handles.startThrows) throw new Error("boom");
        startCalls.push(r.meeting_id);
        return handle("recording");
      },
      async finalize(r) {
        if (handles.finalizeThrows) throw new Error("active recording not found");
        finalizeCalls.push(r.meeting_id);
        return handle(handles.finalizeStatus ?? "finalizing");
      },
      async abort(r) {
        abortCalls.push(r.meeting_id);
        return handle("aborted");
      },
      async status() {
        return handle(seq.shift() ?? "ok");
      },
    },
  };
}

function mkWatcher(over: Partial<VcRecorderDeps> & { client: RecorderClient }) {
  const store = createMemoryStore();
  const dms: string[] = [];
  const queuedKicks: number[] = [];
  const timers: (() => void)[] = [];
  const watcher = createVcRecorderWatcher({
    vcChannelId: VC,
    recordingsDir: "/recordings",
    store,
    dm: async (_u, c) => {
      dms.push(c);
    },
    onQueued: () => queuedKicks.push(1),
    makeId: () => "act-vc",
    now: () => NOW,
    logger,
    maxMinutes: 15,
    pollIntervalMs: 0,
    sleep: async () => {},
    setTimer: (fn) => {
      timers.push(fn);
      return { unref() {} } as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
    ...over,
  });
  return { watcher, store, dms, queuedKicks, timers };
}

const snap = (humanIds: string[]) => ({ guildId: "G1", channelId: VC, humanIds });

describe("createVcRecorderWatcher", () => {
  it("1 人目で start → 2 人目は継続 → 0 人で finalize → ok を queue して kick", async () => {
    const { client, startCalls, finalizeCalls } = fakeClient({ participantIds: ["U1", "U2"] });
    const h = mkWatcher({ client });
    await h.watcher.handleSnapshot(snap(["U1"]));
    await h.watcher.handleSnapshot(snap(["U1", "U2"])); // 複数人でも継続(D3)
    expect(startCalls).toHaveLength(1);
    await h.watcher.handleSnapshot(snap([]));
    expect(finalizeCalls).toHaveLength(1);
    const actions = h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE);
    expect(actions).toHaveLength(1);
    const payload = voiceMemoPayloadSchema.parse(JSON.parse(actions[0]?.payloadJson ?? ""));
    if (!("source" in payload)) throw new Error("vc payload expected");
    expect(payload.authorId).toBe("U1"); // owner = 最初の入室者
    expect(payload.participantIds).toEqual(["U1", "U2"]);
    expect(payload.filePath).toBe("/recordings/m/recording.m4a");
    expect(h.queuedKicks).toHaveLength(1);
    expect(h.dms).toHaveLength(0);
  });

  it("hasActive は録音中のみ true(/interview start の重複ガード・ADR-0028 D5)", async () => {
    const { client } = fakeClient({});
    const h = mkWatcher({ client });
    expect(h.watcher.hasActive()).toBe(false);
    await h.watcher.handleSnapshot(snap(["U1"]));
    expect(h.watcher.hasActive()).toBe(true);
    await h.watcher.handleSnapshot(snap([]));
    expect(h.watcher.hasActive()).toBe(false);
  });

  it("対象外チャンネルのスナップショットは無視する", async () => {
    const { client, startCalls } = fakeClient({});
    const h = mkWatcher({ client });
    await h.watcher.handleSnapshot({ guildId: "G1", channelId: "OTHER", humanIds: ["U1"] });
    expect(startCalls).toHaveLength(0);
  });

  it("時間上限タイマーで自動 finalize(その後の退室では二重 finalize しない)", async () => {
    const { client, finalizeCalls } = fakeClient({});
    const h = mkWatcher({ client });
    await h.watcher.handleSnapshot(snap(["U1"]));
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.(); // 上限発火
    await h.watcher.handleSnapshot(snap([])); // 直列 chain を消化
    expect(finalizeCalls).toHaveLength(1);
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(1);
  });

  it("finalize が failed なら queue せず owner に DM 案内", async () => {
    const { client } = fakeClient({ statusSeq: ["failed"] });
    const h = mkWatcher({ client });
    await h.watcher.handleSnapshot(snap(["U1"]));
    await h.watcher.handleSnapshot(snap([]));
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(0);
    expect(h.dms).toEqual([RECORDING_FAILED_MESSAGE]);
    expect(h.queuedKicks).toHaveLength(0);
  });

  it("start 失敗は owner に DM 案内してセッションを作らない(次の入室で再試行可)", async () => {
    const { client, startCalls } = fakeClient({ startThrows: true });
    const h = mkWatcher({ client });
    await h.watcher.handleSnapshot(snap(["U1"]));
    expect(startCalls).toHaveLength(0);
    expect(h.dms).toEqual([RECORDING_FAILED_MESSAGE]);
    // セッションが無いので再入室でまた start を試みる。
    await h.watcher.handleSnapshot(snap([])); // 0 人 → noop
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(0);
  });
});

// --- ADR-0028 D1/D2/D3: interview チャンク紐付け・自動チャンク分割・再起動復元 ---

function sessionPayload(over: Partial<InterviewSessionPayload> = {}): InterviewSessionPayload {
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
    startedAtJst: "2026-07-17T09:30:00+09:00",
    ...over,
  };
}

function sampleChunk(over: Partial<InterviewChunk> = {}): InterviewChunk {
  return {
    seq: 1,
    meetingId: "vm-old",
    filePath: "/recordings/vm-old/recording.m4a",
    recordedAtJst: "2026-07-17T09:45:00+09:00",
    transcript: null,
    ...over,
  };
}

function fakeBinding(
  over: {
    /** null = アクティブセッション無し(claim しない)。省略時は自動連番で claim。 */
    claims?: null;
    resume?: { id: string; payload: InterviewSessionPayload } | null;
    /** claim/start の順序検証用の共有ログ。 */
    order?: string[];
  } = {},
) {
  const commits: { id: string; chunk: InterviewChunk; participantIds: string[] }[] = [];
  const drops: { id: string; meetingId: string }[] = [];
  const completes: string[] = [];
  let seq = 0;
  const binding: InterviewChunkBinding = {
    claimChunk(meetingId) {
      over.order?.push(`claim:${meetingId}`);
      if (over.claims === null) return null;
      seq += 1;
      return { sessionActionId: "act-i", seq };
    },
    commitChunk(id, chunk, participantIds) {
      commits.push({ id, chunk, participantIds });
    },
    dropChunk(id, meetingId) {
      drops.push({ id, meetingId });
    },
    completeSession(id) {
      completes.push(id);
    },
    resumeTarget() {
      return over.resume ?? null;
    },
  };
  return { binding, commits, drops, completes };
}

/** meetingId が重複しないよう now() を進める時計。 */
function ticking(startMs = NOW.getTime()) {
  let t = startMs;
  return () => {
    t += 60_000;
    return new Date(t);
  };
}

describe("createVcRecorderWatcher: 自動チャンク分割(ADR-0028 D2/D3)", () => {
  it("上限到達 → finalize 完了後に fetchSnapshot(人数 1)→ 新 meetingId で再 start(通常経路も連結・D3)", async () => {
    const { client, startCalls, finalizeCalls } = fakeClient({});
    const h = mkWatcher({
      client,
      now: ticking(),
      fetchSnapshot: async () => snap(["U1"]),
    });
    await h.watcher.handleSnapshot(snap(["U1"]));
    h.timers[0]?.(); // 上限発火
    await h.watcher.handleSnapshot(snap(["U1"])); // 直列 chain を消化(active 有 + 1 人 = noop)
    expect(finalizeCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1]).not.toBe(startCalls[0]); // 新 meetingId
    // 旧チャンクは従来どおり voice_memo として queue 済み(1 チャンク = 1 メモの連結)。
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(1);
  });

  it("上限到達 → fetchSnapshot が 0 人なら再 start しない", async () => {
    const { client, startCalls, finalizeCalls } = fakeClient({});
    const h = mkWatcher({ client, now: ticking(), fetchSnapshot: async () => snap([]) });
    await h.watcher.handleSnapshot(snap(["U1"]));
    h.timers[0]?.();
    await h.watcher.handleSnapshot(snap([])); // 直列 chain を消化(active 無 + 0 人 = noop)
    expect(finalizeCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(1);
  });

  it("fetchSnapshot 未注入なら上限で従来どおり切れる(rotation なし)", async () => {
    const { client, startCalls, finalizeCalls } = fakeClient({});
    const h = mkWatcher({ client, now: ticking() });
    await h.watcher.handleSnapshot(snap(["U1"]));
    h.timers[0]?.();
    await h.watcher.handleSnapshot(snap([])); // 直列 chain を消化(active 無 + 0 人 = noop)
    expect(finalizeCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(1);
  });
});

describe("createVcRecorderWatcher: interview チャンク紐付け(ADR-0028 D1/D2)", () => {
  it("claimChunk は recorder.start より先に呼ばれる(クラッシュ耐性の順序)", async () => {
    const order: string[] = [];
    const { client } = fakeClient({});
    const wrapped: RecorderClient = {
      ...client,
      start: async (r) => {
        order.push(`start:${r.meeting_id}`);
        return client.start(r);
      },
    };
    const b = fakeBinding({ order });
    const h = mkWatcher({ client: wrapped, chunkBinding: b.binding });
    await h.watcher.handleSnapshot(snap(["U1"]));
    expect(order).toHaveLength(2);
    expect(order[0]?.startsWith("claim:")).toBe(true);
    expect(order[1]?.startsWith("start:")).toBe(true);
  });

  it("interview チャンクは voice_memo を積まず commitChunk し、全員退室で completeSession", async () => {
    const { client } = fakeClient({ participantIds: ["U1", "U2"] });
    const b = fakeBinding({});
    const h = mkWatcher({ client, chunkBinding: b.binding, now: ticking() });
    await h.watcher.handleSnapshot(snap(["U1"]));
    await h.watcher.handleSnapshot(snap([])); // 全員退室 = cause "empty"
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(0);
    expect(h.queuedKicks).toHaveLength(0);
    expect(b.commits).toHaveLength(1);
    expect(b.commits[0]?.chunk.seq).toBe(1);
    expect(b.commits[0]?.chunk.filePath).toBe("/recordings/m/recording.m4a");
    expect(b.commits[0]?.participantIds).toEqual(["U1", "U2"]);
    expect(b.completes).toEqual(["act-i"]);
    expect(h.dms).toHaveLength(0);
  });

  it("finalize failed(無音等)の interview チャンクは dropChunk のみ(DM しない)で続行", async () => {
    const { client } = fakeClient({ statusSeq: ["failed"] });
    const b = fakeBinding({});
    const h = mkWatcher({ client, chunkBinding: b.binding, now: ticking() });
    await h.watcher.handleSnapshot(snap(["U1"]));
    await h.watcher.handleSnapshot(snap([]));
    expect(b.commits).toHaveLength(0);
    expect(b.drops).toHaveLength(1);
    expect(b.completes).toEqual(["act-i"]); // 欠番でもセッションは完了処理へ
    expect(h.dms).toHaveLength(0);
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(0);
  });

  it("start 失敗時は claim 済みチャンクを dropChunk する", async () => {
    const { client } = fakeClient({ startThrows: true });
    const b = fakeBinding({});
    const h = mkWatcher({ client, chunkBinding: b.binding });
    await h.watcher.handleSnapshot(snap(["U1"]));
    expect(b.drops).toHaveLength(1);
    expect(b.drops[0]?.id).toBe("act-i");
  });

  it("上限 rotation: commitChunk → 人数 1 なら次チャンクを claim して再 start / 0 人なら completeSession", async () => {
    const withPeople = (() => {
      const { client, startCalls } = fakeClient({});
      const b = fakeBinding({});
      const h = mkWatcher({
        client,
        chunkBinding: b.binding,
        now: ticking(),
        fetchSnapshot: async () => snap(["U1"]),
      });
      return { client, startCalls, b, h };
    })();
    await withPeople.h.watcher.handleSnapshot(snap(["U1"]));
    withPeople.h.timers[0]?.();
    await withPeople.h.watcher.handleSnapshot(snap(["U1"]));
    expect(withPeople.b.commits.map((c) => c.chunk.seq)).toEqual([1]);
    expect(withPeople.startCalls).toHaveLength(2);
    expect(withPeople.b.completes).toHaveLength(0); // セッション継続中
    expect(withPeople.h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(0);

    const empty = (() => {
      const { client, startCalls } = fakeClient({});
      const b = fakeBinding({});
      const h = mkWatcher({
        client,
        chunkBinding: b.binding,
        now: ticking(),
        fetchSnapshot: async () => snap([]),
      });
      return { startCalls, b, h };
    })();
    await empty.h.watcher.handleSnapshot(snap(["U1"]));
    empty.h.timers[0]?.();
    await empty.h.watcher.handleSnapshot(snap([])); // chain 消化(active 無 + 0 人 = noop)
    expect(empty.b.commits).toHaveLength(1);
    expect(empty.startCalls).toHaveLength(1);
    expect(empty.b.completes).toEqual(["act-i"]);
  });

  it("binding 注入でもセッション無し(claim が null)なら従来の voice_memo 経路", async () => {
    const { client } = fakeClient({ participantIds: ["U1", "U2"] });
    const b = fakeBinding({ claims: null });
    const h = mkWatcher({ client, chunkBinding: b.binding });
    await h.watcher.handleSnapshot(snap(["U1"]));
    await h.watcher.handleSnapshot(snap([]));
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(1);
    expect(h.queuedKicks).toHaveLength(1);
    expect(b.commits).toHaveLength(0);
    expect(b.completes).toHaveLength(0);
  });
});

describe("createVcRecorderWatcher: 再起動復元(resume・ADR-0028 D1)", () => {
  it("currentChunk を冪等 finalize して commit し、人数 1 なら次チャンクを開始する", async () => {
    const { client, startCalls, finalizeCalls } = fakeClient({ participantIds: ["U1"] });
    const b = fakeBinding({
      resume: {
        id: "act-i",
        payload: sessionPayload({ currentChunk: { seq: 2, meetingId: "vm-old" } }),
      },
    });
    const h = mkWatcher({
      client,
      chunkBinding: b.binding,
      now: ticking(),
      fetchSnapshot: async () => snap(["U1"]),
    });
    await h.watcher.resume();
    expect(finalizeCalls).toEqual(["vm-old"]);
    expect(b.commits).toHaveLength(1);
    expect(b.commits[0]?.chunk).toMatchObject({ seq: 2, meetingId: "vm-old" });
    expect(startCalls).toHaveLength(1); // 次チャンク開始(owner は starterId 継承)
    expect(b.completes).toHaveLength(0);
    // 再開後は通常の状態機械に乗る(全員退室で finalize できる)。
    await h.watcher.handleSnapshot(snap([]));
    expect(b.completes).toEqual(["act-i"]);
  });

  it("sidecar が録音を知らない(throw)なら dropChunk(欠番)し、0 人なら completeSession", async () => {
    const { client, startCalls } = fakeClient({ finalizeThrows: true });
    const b = fakeBinding({
      resume: {
        id: "act-i",
        payload: sessionPayload({ currentChunk: { seq: 1, meetingId: "vm-lost" } }),
      },
    });
    const h = mkWatcher({
      client,
      chunkBinding: b.binding,
      fetchSnapshot: async () => snap([]),
    });
    await h.watcher.resume();
    expect(b.drops).toEqual([{ id: "act-i", meetingId: "vm-lost" }]);
    expect(b.commits).toHaveLength(0);
    expect(startCalls).toHaveLength(0);
    expect(b.completes).toEqual(["act-i"]);
  });

  it("currentChunk が null で chunks>0(録音間の再起動)なら finalize せず completeSession", async () => {
    const { client, startCalls, finalizeCalls } = fakeClient({});
    const b = fakeBinding({
      resume: { id: "act-i", payload: sessionPayload({ chunks: [sampleChunk()] }) },
    });
    const h = mkWatcher({
      client,
      chunkBinding: b.binding,
      fetchSnapshot: async () => snap(["U1"]),
    });
    await h.watcher.resume();
    expect(finalizeCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(0);
    expect(b.completes).toEqual(["act-i"]);
  });

  it("復元対象が無ければ何もしない(binding 未注入も同様)", async () => {
    const noTarget = fakeClient({});
    const b = fakeBinding({ resume: null });
    const h1 = mkWatcher({ client: noTarget.client, chunkBinding: b.binding });
    await h1.watcher.resume();
    expect(noTarget.finalizeCalls).toHaveLength(0);
    const noBinding = fakeClient({});
    const h2 = mkWatcher({ client: noBinding.client });
    await h2.watcher.resume();
    expect(noBinding.finalizeCalls).toHaveLength(0);
  });
});

describe("createVcRecorderWatcher: abortActive(/interview cancel 用)", () => {
  it("進行中の録音を abort し、interview チャンクは dropChunk・次の入室で再 start できる", async () => {
    const { client, startCalls, abortCalls } = fakeClient({});
    const b = fakeBinding({});
    const h = mkWatcher({ client, chunkBinding: b.binding, now: ticking() });
    await h.watcher.handleSnapshot(snap(["U1"]));
    await h.watcher.abortActive("interview cancel");
    expect(abortCalls).toHaveLength(1);
    expect(b.drops).toHaveLength(1);
    expect(h.store.listPendingActions(VOICE_MEMO_ACTION_TYPE)).toHaveLength(0);
    // active はクリア済み → 再入室で新しい録音を開始できる。
    await h.watcher.handleSnapshot(snap(["U1"]));
    expect(startCalls).toHaveLength(2);
  });

  it("active が無ければ no-op", async () => {
    const { client, abortCalls } = fakeClient({});
    const h = mkWatcher({ client });
    await h.watcher.abortActive("nothing");
    expect(abortCalls).toHaveLength(0);
  });
});
