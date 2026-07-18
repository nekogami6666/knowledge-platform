import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "./db.js";
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
}): { client: RecorderClient; startCalls: string[]; finalizeCalls: string[] } {
  const startCalls: string[] = [];
  const finalizeCalls: string[] = [];
  const seq = [...(handles.statusSeq ?? ["ok"])];
  const handle = (status: RecorderHandle["status"]): RecorderHandle => ({
    status,
    file_path: "/recordings/m/recording.m4a",
    participant_ids: handles.participantIds ?? ["U1"],
  });
  return {
    startCalls,
    finalizeCalls,
    client: {
      async start(r) {
        if (handles.startThrows) throw new Error("boom");
        startCalls.push(r.meeting_id);
        return handle("recording");
      },
      async finalize(r) {
        finalizeCalls.push(r.meeting_id);
        return handle(handles.finalizeStatus ?? "finalizing");
      },
      async abort() {
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
