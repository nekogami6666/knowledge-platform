/**
 * VC 録音の制御プレーン(design.md §6.4 ③-b / ADR-0020・PR-V7)。
 * 専用 VC(voice.yaml の vc_channel_id)の入退室スナップショットから録音 sidecar
 * (sidecars/voice-recorder・HTTP 契約は QB-Meeting-Ops と同形)を駆動する:
 * **1 人目の入室で開始・全員退室(0 人)or 時間上限で finalize・複数人でも継続**(D3)。
 * owner(DM 先・起票者)= 最初の入室者。finalize の成果(recording.m4a)は
 * pending_actions(type: voice_memo・source:"vc")へ積み、既存 voice-pipeline が STT 以降を担う。
 * 判定は純関数・副作用(HTTP/store/DM/タイマー)は注入 seam(freshness-flow と同じ流儀)。
 */
import type { Logger } from "pino";
import type { BotStore } from "./db.js";
import type { InterviewChunkBinding } from "./interview-session.js";
import { withCorrelation } from "./logger.js";
import { isoJst } from "./time.js";
import { type VcVoiceMemoPayload, VOICE_MEMO_ACTION_TYPE } from "./voice.js";

// --- sidecar HTTP 契約(server.js が実際に読む 4 フィールドだけを送る)---

export interface RecorderRecord {
  meeting_id: string;
  guild_id: string;
  voice_channel_id: string;
  local_root_dir: string;
}

/** sidecar の全エンドポイント共通レスポンス(必要フィールドのみ)。 */
export interface RecorderHandle {
  status: "recording" | "finalizing" | "ok" | "aborted" | "failed" | string;
  /** 常に <local_root_dir>/recording.m4a(契約)。 */
  file_path: string;
  participant_ids?: string[];
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RecorderClient {
  start(record: RecorderRecord): Promise<RecorderHandle>;
  finalize(record: RecorderRecord): Promise<RecorderHandle>;
  abort(record: RecorderRecord, reason: string): Promise<RecorderHandle>;
  status(meetingId: string): Promise<RecorderHandle>;
}

export function createRecorderClient(baseUrl: string, fetchFn?: FetchLike): RecorderClient {
  const f = fetchFn ?? (fetch as unknown as FetchLike);
  const base = baseUrl.replace(/\/$/, "");
  const post = async (path: string, body: unknown): Promise<RecorderHandle> => {
    const res = await f(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`recorder ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as RecorderHandle;
  };
  return {
    start: (record) => post("/recordings/start", { record, started_at: null }),
    finalize: (record) => post("/recordings/finalize", { record, finished_at: null }),
    abort: (record, reason) => post("/recordings/abort", { record, aborted_at: null, reason }),
    async status(meetingId) {
      const res = await f(`${base}/recordings/status/${meetingId}`);
      if (!res.ok) throw new Error(`recorder status failed: HTTP ${res.status}`);
      return (await res.json()) as RecorderHandle;
    },
  };
}

// --- 判定(純関数)---

export type VcAction = "start" | "finalize" | "noop";

/** ADR-0020 D3: セッション無 + 1 人以上 → start / セッション有 + 0 人 → finalize / 他 → noop。 */
export function vcSessionDecision(hasActive: boolean, participantCount: number): VcAction {
  if (!hasActive && participantCount >= 1) return "start";
  if (hasActive && participantCount === 0) return "finalize";
  return "noop";
}

// --- watcher(セッション保持 + 上限タイマー + finalize 後のポーリング)---

/** 専用 VC の現在参加者(bot 除外済み)。discord.ts のグルーが組み立てる純データ。 */
export interface VcSnapshot {
  guildId: string;
  channelId: string;
  /** 人間の参加者 ID(入室順は保証されないため owner は watcher が最初の start 時に確定する)。 */
  humanIds: string[];
}

export interface VcRecorderDeps {
  /** 対象 VC(voice.yaml vc_channel_id)。 */
  vcChannelId: string;
  /** 録音ファイル共有マウントのルート(env RECORDINGS_DIR。sidecar と同一パス)。 */
  recordingsDir: string;
  client: RecorderClient;
  store: BotStore;
  /** 失敗案内の DM(実装は createClientMessenger.dm)。 */
  dm(userId: string, content: string): Promise<void>;
  /** キュー投入後に voice-pipeline を起こす hook。 */
  onQueued(): void;
  makeId(): string;
  now(): Date;
  logger: Logger;
  /** 自動 finalize の上限(分)。 */
  maxMinutes: number;
  /**
   * 現在の VC 参加者を取り直す(ADR-0028 D2/D3。上限 rotation・再起動 resume が使う)。
   * 未注入なら上限到達で従来どおり切れる(自動チャンク分割 OFF)。
   */
  fetchSnapshot?: () => Promise<VcSnapshot | null>;
  /** interview セッションへのチャンク紐付け(ADR-0028 D1)。未注入なら通常 voice_memo 経路のみ。 */
  chunkBinding?: InterviewChunkBinding;
  /** finalize 後の status ポーリング間隔/上限(テスト注入用)。 */
  pollIntervalMs?: number;
  maxPollMs?: number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface ActiveSession {
  record: RecorderRecord;
  ownerId: string;
  limitTimer: NodeJS.Timeout;
  /** interview セッションに claim 済みのチャンク(ADR-0028 D1)。無ければ通常 voice_memo。 */
  interview?: { sessionActionId: string; seq: number };
}

export const RECORDING_FAILED_MESSAGE =
  "🎙️ VC 録音の処理に失敗しました。もう一度録音するか、音声ファイルを #voice-memo に投稿してください。";

export interface VcRecorderWatcher {
  handleSnapshot(snapshot: VcSnapshot): Promise<void>;
  /**
   * 再起動復元(ADR-0028 D1。ClientReady から呼ぶ): state:"recording" の interview セッションの
   * currentChunk を冪等 finalize し、VC の現在人数で次チャンク開始かセッション完了を選ぶ。
   */
  resume(): Promise<void>;
  /** 進行中の録音を破棄する(/interview cancel 用。interview チャンクは欠番)。 */
  abortActive(reason: string): Promise<void>;
  /** 録音が進行中か(/interview start の「通常録音進行中は拒否」ガード・ADR-0028 D5)。 */
  hasActive(): boolean;
}

export function createVcRecorderWatcher(deps: VcRecorderDeps): VcRecorderWatcher {
  const log = withCorrelation(deps.logger, "vc-recorder");
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let active: ActiveSession | null = null;
  // 直列化: 入退室イベントとタイマーが重なっても start/finalize が交錯しないように順に処理する。
  let chain: Promise<void> = Promise.resolve();

  const pollUntilDone = async (meetingId: string): Promise<RecorderHandle> => {
    const interval = deps.pollIntervalMs ?? 3000;
    const deadline = Date.now() + (deps.maxPollMs ?? 120_000);
    for (;;) {
      const handle = await deps.client.status(meetingId);
      if (handle.status !== "finalizing" && handle.status !== "recording") return handle;
      if (Date.now() >= deadline) throw new Error("recorder finalize polling timed out");
      await sleep(interval);
    }
  };

  /** finalize 済みチャンクを interview payload へ commit する(voice_memo は積まない・ADR-0028 D1)。 */
  const commitInterviewChunk = (
    binding: InterviewChunkBinding,
    meetingId: string,
    interview: { sessionActionId: string; seq: number },
    handle: RecorderHandle,
  ): void => {
    binding.commitChunk(
      interview.sessionActionId,
      {
        seq: interview.seq,
        meetingId,
        filePath: handle.file_path,
        recordedAtJst: isoJst(deps.now()),
        transcript: null,
      },
      handle.participant_ids ?? [],
    );
  };

  const doFinalize = async (session: ActiveSession, cause: string): Promise<void> => {
    clearTimer(session.limitTimer);
    active = null;
    const interview = session.interview;
    try {
      const first = await deps.client.finalize(session.record);
      const handle =
        first.status === "finalizing" ? await pollUntilDone(session.record.meeting_id) : first;
      if (handle.status !== "ok") {
        throw new Error(`recorder finalize status=${handle.status}`);
      }
      if (interview !== undefined && deps.chunkBinding !== undefined) {
        commitInterviewChunk(deps.chunkBinding, session.record.meeting_id, interview, handle);
        log.info(
          { meetingId: session.record.meeting_id, seq: interview.seq, cause },
          "interview chunk committed",
        );
      } else {
        const payload: VcVoiceMemoPayload = {
          source: "vc",
          meetingId: session.record.meeting_id,
          filePath: handle.file_path,
          guildId: session.record.guild_id,
          channelId: session.record.voice_channel_id,
          authorId: session.ownerId,
          participantIds: handle.participant_ids ?? [],
          recordedAtJst: isoJst(deps.now()),
        };
        deps.store.queueAction({
          id: deps.makeId(),
          type: VOICE_MEMO_ACTION_TYPE,
          queryId: null,
          payloadJson: JSON.stringify(payload),
          state: "pending",
          createdAt: isoJst(deps.now()),
        });
        deps.onQueued();
        log.info({ meetingId: session.record.meeting_id, cause }, "vc recording queued");
      }
    } catch (err) {
      if (interview !== undefined && deps.chunkBinding !== undefined) {
        // 無音チャンク(finalize "failed")等は欠番として続行(ADR-0028 D2)。owner に DM しない。
        log.warn(
          { err, meetingId: session.record.meeting_id, seq: interview.seq, cause },
          "interview chunk finalize failed; dropped(欠番)",
        );
        deps.chunkBinding.dropChunk(interview.sessionActionId, session.record.meeting_id);
      } else {
        // 録音は失われている可能性が高い(pending は積まない)。本人に案内して運用ログに残す。
        log.error({ err, meetingId: session.record.meeting_id, cause }, "vc finalize failed");
        try {
          await deps.dm(session.ownerId, RECORDING_FAILED_MESSAGE);
        } catch (dmErr) {
          // VC 入室には元メッセージが無く、DM 以外の通知先が無い(ADR-0030 D2 の限界)。
          // 本人には届かないため、管理者が気づけるよう warn で残す。
          log.warn(
            { err: dmErr, ownerId: session.ownerId },
            "録音失敗の DM を送れませんでした(本人に届いていません)",
          );
        }
      }
    }
    // --- チャンク境界の後処理(ADR-0028 D2/D3)。既存 chain 上で直列に行う ---
    try {
      if (cause === "empty") {
        // 全員退室 = セッションの区切り(interview はここで STT キューへ)。
        if (interview !== undefined) deps.chunkBinding?.completeSession(interview.sessionActionId);
        return;
      }
      if (cause === "max-minutes" && deps.fetchSnapshot !== undefined) {
        // 上限 rotation: finalize 完了(接続 destroy 済み)を待ってから直列に次チャンクを開始する
        // (sidecar は 1 guild 1 接続。並行 start は新チャンクが無音になる・ADR-0028 D2)。
        const snapshot = await deps.fetchSnapshot();
        if (snapshot !== null && snapshot.humanIds.length >= 1) {
          await doStart(snapshot, { inheritOwnerId: session.ownerId });
        } else if (interview !== undefined) {
          deps.chunkBinding?.completeSession(interview.sessionActionId);
        }
      }
    } catch (err) {
      // rotation 失敗で chain を汚さない(以降の入退室処理を生かす)。interview は完了へ倒す。
      log.error({ err, meetingId: session.record.meeting_id, cause }, "vc chunk rotation failed");
      if (interview !== undefined) deps.chunkBinding?.completeSession(interview.sessionActionId);
    }
  };

  const doStart = async (
    snapshot: VcSnapshot,
    opts?: { inheritOwnerId?: string },
  ): Promise<void> => {
    // rotation / resume は旧チャンクの owner(DM 先)を継承する(ADR-0028 D2/D3)。
    const ownerId = opts?.inheritOwnerId ?? snapshot.humanIds[0];
    if (ownerId === undefined) return;
    const now = deps.now();
    const meetingId = `vm-${now.getTime()}-${snapshot.channelId}`;
    const record: RecorderRecord = {
      meeting_id: meetingId,
      guild_id: snapshot.guildId,
      voice_channel_id: snapshot.channelId,
      local_root_dir: `${deps.recordingsDir}/${meetingId}`,
    };
    // ADR-0028 D1: recorder.start より先に claim を永続化する
    // (start 直後にクラッシュしても resume が currentChunk を冪等 finalize できる)。
    const claim = deps.chunkBinding?.claimChunk(meetingId, isoJst(now)) ?? null;
    try {
      await deps.client.start(record);
    } catch (err) {
      log.error({ err, meetingId }, "vc recording start failed");
      if (claim !== null) deps.chunkBinding?.dropChunk(claim.sessionActionId, meetingId);
      try {
        await deps.dm(ownerId, RECORDING_FAILED_MESSAGE);
      } catch {
        // ログ済み。
      }
      return;
    }
    const limitTimer = setTimer(
      () => {
        chain = chain.then(() => {
          const s = active;
          // タイマー発火時点でまだ同じセッションが生きている場合のみ上限 finalize。
          if (s !== null && s.record.meeting_id === meetingId) return doFinalize(s, "max-minutes");
          return undefined;
        });
      },
      deps.maxMinutes * 60 * 1000,
    );
    limitTimer.unref?.();
    active = {
      record,
      ownerId,
      limitTimer,
      ...(claim !== null
        ? { interview: { sessionActionId: claim.sessionActionId, seq: claim.seq } }
        : {}),
    };
    log.info({ meetingId, ownerId, interview: claim !== null }, "vc recording started");
  };

  /** 再起動復元の本体(ADR-0028 D1)。chain 上で直列に呼ばれる。 */
  const doResume = async (): Promise<void> => {
    const binding = deps.chunkBinding;
    if (binding === undefined) return;
    const target = binding.resumeTarget();
    if (target === null) return;
    const { id, payload } = target;
    const cur = payload.currentChunk;
    if (cur === null) {
      // 録音間(チャンク境界)の再起動: 復元すべき録音は無い。chunks 有なら STT キューへ、
      // 0 件なら cancelled(completeSession が判定する)。
      binding.completeSession(id);
      return;
    }
    // currentChunk を冪等 finalize(sidecar の finalize ジョブは冪等)。sidecar も再起動済みで
    // "active recording not found" 等を throw したら録音は失われている → 欠番(ADR-0028 D1)。
    const record: RecorderRecord = {
      meeting_id: cur.meetingId,
      guild_id: payload.guildId,
      voice_channel_id: payload.channelId,
      local_root_dir: `${deps.recordingsDir}/${cur.meetingId}`,
    };
    try {
      const first = await deps.client.finalize(record);
      const handle = first.status === "finalizing" ? await pollUntilDone(cur.meetingId) : first;
      if (handle.status !== "ok") {
        throw new Error(`recorder finalize status=${handle.status}`);
      }
      commitInterviewChunk(binding, cur.meetingId, { sessionActionId: id, seq: cur.seq }, handle);
      log.info({ meetingId: cur.meetingId, seq: cur.seq }, "interview chunk resumed(committed)");
    } catch (err) {
      log.warn({ err, meetingId: cur.meetingId, seq: cur.seq }, "resume finalize failed; 欠番");
      binding.dropChunk(id, cur.meetingId);
    }
    const snapshot = deps.fetchSnapshot !== undefined ? await deps.fetchSnapshot() : null;
    if (snapshot !== null && snapshot.humanIds.length >= 1) {
      await doStart(snapshot, { inheritOwnerId: payload.starterId });
    } else {
      binding.completeSession(id);
    }
  };

  return {
    handleSnapshot(snapshot) {
      if (snapshot.channelId !== deps.vcChannelId) return Promise.resolve();
      chain = chain.then(async () => {
        const action = vcSessionDecision(active !== null, snapshot.humanIds.length);
        if (action === "start") await doStart(snapshot);
        else if (action === "finalize" && active !== null) await doFinalize(active, "empty");
      });
      return chain;
    },
    resume() {
      chain = chain.then(async () => {
        try {
          await doResume();
        } catch (err) {
          // 復元失敗で以降の入退室処理を止めない。
          log.error({ err }, "vc recorder resume failed");
        }
      });
      return chain;
    },
    abortActive(reason) {
      chain = chain.then(async () => {
        const s = active;
        if (s === null) return;
        clearTimer(s.limitTimer);
        active = null;
        try {
          await deps.client.abort(s.record, reason);
        } catch (err) {
          log.warn({ err, meetingId: s.record.meeting_id, reason }, "vc abort failed");
        }
        if (s.interview !== undefined) {
          deps.chunkBinding?.dropChunk(s.interview.sessionActionId, s.record.meeting_id);
        }
        log.info({ meetingId: s.record.meeting_id, reason }, "vc recording aborted");
      });
      return chain;
    },
    hasActive() {
      return active !== null;
    },
  };
}
