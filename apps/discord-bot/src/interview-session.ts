/**
 * interview セッション(ADR-0028 D1)の pending_actions 契約と状態機械。
 * 書き手は /interview start(後続 PR)と vc-recorder(チャンク紐付け)、読み手は
 * セッション worker(STT 結合 → 原本 PR・後続 PR)。app 間で型を再定義しない(§12.2)ため、
 * pending_actions の所有者である discord-bot がこの契約を持つ(freshness.ts と同じ所有権)。
 *
 * state 意味論(ADR-0028 D1):
 * - "armed"     … /interview start 宣言済み・録音前。startedAtJst から TTL
 *                 (voice.yaml interview_arm_ttl_minutes)超過で lazy に "cancelled" へ落とす。
 * - "recording" … チャンク録音中(currentChunk が再起動復元の手掛かり)。
 * - "pending"   … 全チャンク録音完了・STT / 原本 PR 待ち(セッション worker が消費)。
 * - done        … markActionDone(消費完了)。
 * - "cancelled" … 明示 /interview cancel・TTL 失効・チャンク 0 件での完了。
 */
import type { Logger } from "pino";
import { z } from "zod";
import type { BotStore } from "./db.js";

/** PendingAction.type の値(ADR-0028 D1)。 */
export const INTERVIEW_SESSION_ACTION_TYPE = "interview_session";

/** 録音済みチャンク 1 本(seq 順に結合して原本になる・ADR-0028 D4)。 */
export const interviewChunkSchema = z
  .object({
    /** セッション内の連番(1 始まり)。finalize 失敗チャンクは欠番になる(ADR-0028 D2)。 */
    seq: z.number().int().positive(),
    meetingId: z.string().min(1),
    /** sidecar 出力(<local_root_dir>/recording.m4a)。 */
    filePath: z.string().min(1),
    recordedAtJst: z.string().min(1),
    /** STT 結果のキャッシュ(ADR-0028 D4。null = 未実施。再試行で再 STT しない)。 */
    transcript: z.string().nullable().default(null),
    /** transcript キャッシュと対の STT モデル(原本メタ用・ADR-0028 D4)。未 STT は省略。 */
    sttModel: z.string().optional(),
  })
  .strict();
export type InterviewChunk = z.infer<typeof interviewChunkSchema>;

export const interviewSessionPayloadSchema = z
  .object({
    /** 冪等キー(原本ファイル名のサフィックスにも使う・ADR-0028 D4)。 */
    sessionId: z.string().min(1),
    person: z.string().min(1),
    topic: z.string().min(1),
    /** 質問キット(interviews/kits/...)への参照。null = キット無し。 */
    kitPath: z.string().nullable(),
    guildId: z.string().min(1),
    channelId: z.string().min(1),
    /** /interview start の実行者(= owner・DM 先)。 */
    starterId: z.string().min(1),
    /** チャンク横断の発話者の和集合(ADR-0028 D2)。 */
    participantIds: z.array(z.string()).default([]),
    chunks: z.array(interviewChunkSchema).default([]),
    /** 録音中チャンク(再起動復元用・ADR-0028 D1)。録音外は null。 */
    currentChunk: z
      .object({ seq: z.number().int().positive(), meetingId: z.string().min(1) })
      .nullable()
      .default(null),
    startedAtJst: z.string().min(1),
  })
  .strict();
export type InterviewSessionPayload = z.infer<typeof interviewSessionPayloadSchema>;

/** payloadJson を検証付きで parse する。壊れていれば null(呼び手が捨てる)。 */
export function parseInterviewSessionPayload(json: string | null): InterviewSessionPayload | null {
  if (json === null) return null;
  try {
    return interviewSessionPayloadSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/** アクティブ(armed | recording)なセッション 1 件。 */
export interface ActiveInterviewSession {
  id: string;
  state: string;
  payload: InterviewSessionPayload;
}

/**
 * アクティブな interview セッション(armed | recording)を返す(同時に有効なのは全体で
 * 1 件・ADR-0028 D5)。armed が TTL(分)を超過していれば "cancelled" へ落として null 扱い
 * (lazy 失効)。壊れた payload は markActionDone で捨てる(voice-pipeline の作法)。
 */
export function findActiveInterviewSession(
  store: BotStore,
  now: Date,
  armTtlMinutes: number,
): ActiveInterviewSession | null {
  // listPendingActions は state を絞らず type の全行を返す(done/cancelled 込み)ため自前で絞る。
  for (const action of store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)) {
    if (action.state !== "armed" && action.state !== "recording") continue;
    const payload = parseInterviewSessionPayload(action.payloadJson);
    if (payload === null) {
      store.markActionDone(action.id);
      continue;
    }
    if (
      action.state === "armed" &&
      now.getTime() - Date.parse(payload.startedAtJst) > armTtlMinutes * 60 * 1000
    ) {
      store.setActionState(action.id, "cancelled");
      continue;
    }
    return { id: action.id, state: action.state, payload };
  }
  return null;
}

/** vc-recorder がチャンクをセッションへ紐付けるための seam(ADR-0028 D1/D2)。 */
export interface InterviewChunkBinding {
  /**
   * 録音開始前に呼ぶ: アクティブセッションがあれば currentChunk を永続化して
   * state を "recording" に進める(クラッシュしても resume で finalize できる)。
   * セッションが無ければ null(通常 voice_memo 経路)。
   */
  claimChunk(
    meetingId: string,
    recordedAtJst: string,
  ): { sessionActionId: string; seq: number } | null;
  /** finalize 成功後: chunks に追記・currentChunk クリア・participantIds を和集合に。 */
  commitChunk(sessionActionId: string, chunk: InterviewChunk, participantIds: string[]): void;
  /** finalize 失敗(無音等)・start 失敗: currentChunk をクリアするだけ(seq は欠番)。 */
  dropChunk(sessionActionId: string, meetingId: string): void;
  /** チャンク有 → "pending" + onQueued() / 0 件 → "cancelled"(ADR-0028 D1)。 */
  completeSession(sessionActionId: string): void;
  /** 再起動復元の対象(state==="recording" の 1 件)。無ければ null。 */
  resumeTarget(): { id: string; payload: InterviewSessionPayload } | null;
}

export interface InterviewChunkBindingDeps {
  store: BotStore;
  now(): Date;
  /** armed の失効(voice.yaml interview_arm_ttl_minutes)。 */
  armTtlMinutes: number;
  /** "pending" へ進めたときにセッション worker を起こす hook。 */
  onQueued(): void;
  logger: Logger;
}

export function createInterviewChunkBinding(
  deps: InterviewChunkBindingDeps,
): InterviewChunkBinding {
  const log = deps.logger;

  /** id で読み直して検証付き parse(壊れていれば markActionDone して null)。 */
  const readSession = (id: string): InterviewSessionPayload | null => {
    const action = deps.store
      .listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)
      .find((a) => a.id === id);
    if (action === undefined) {
      log.warn({ sessionActionId: id }, "interview session not found");
      return null;
    }
    const payload = parseInterviewSessionPayload(action.payloadJson);
    if (payload === null) {
      // 壊れた payload は再試行しても直らない: markActionDone で捨てる(voice-pipeline の作法)。
      log.error({ sessionActionId: id }, "invalid interview payload; discarding");
      deps.store.markActionDone(id);
      return null;
    }
    return payload;
  };

  const save = (id: string, payload: InterviewSessionPayload): void => {
    deps.store.setActionPayload(id, JSON.stringify(payload));
  };

  return {
    claimChunk(meetingId, _recordedAtJst) {
      const active = findActiveInterviewSession(deps.store, deps.now(), deps.armTtlMinutes);
      if (active === null) return null;
      // 次連番: dropChunk 後も currentChunk 消失前の最大値を跨がないよう既知の最大 seq + 1。
      const seq =
        Math.max(
          0,
          ...active.payload.chunks.map((c) => c.seq),
          active.payload.currentChunk?.seq ?? 0,
        ) + 1;
      save(active.id, { ...active.payload, currentChunk: { seq, meetingId } });
      deps.store.setActionState(active.id, "recording");
      log.info({ sessionActionId: active.id, seq, meetingId }, "interview chunk claimed");
      return { sessionActionId: active.id, seq };
    },
    commitChunk(sessionActionId, chunk, participantIds) {
      const payload = readSession(sessionActionId);
      if (payload === null) return;
      const union = [
        ...payload.participantIds,
        ...participantIds.filter((p) => !payload.participantIds.includes(p)),
      ];
      save(sessionActionId, {
        ...payload,
        chunks: [...payload.chunks, chunk],
        currentChunk: null,
        participantIds: union,
      });
      log.info({ sessionActionId, seq: chunk.seq }, "interview chunk committed");
    },
    dropChunk(sessionActionId, meetingId) {
      const payload = readSession(sessionActionId);
      if (payload === null) return;
      if (payload.currentChunk === null || payload.currentChunk.meetingId !== meetingId) return;
      save(sessionActionId, { ...payload, currentChunk: null });
      log.warn({ sessionActionId, meetingId }, "interview chunk dropped(欠番)");
    },
    completeSession(sessionActionId) {
      const payload = readSession(sessionActionId);
      if (payload === null) return;
      if (payload.chunks.length > 0) {
        deps.store.setActionState(sessionActionId, "pending");
        deps.onQueued();
        log.info(
          { sessionActionId, chunks: payload.chunks.length },
          "interview session queued(pending)",
        );
      } else {
        // チャンク 0 件の完了はセッション成立せず(ADR-0028 D1)。
        deps.store.setActionState(sessionActionId, "cancelled");
        log.warn({ sessionActionId }, "interview session cancelled(チャンク 0 件)");
      }
    },
    resumeTarget() {
      for (const action of deps.store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)) {
        if (action.state !== "recording") continue;
        const payload = parseInterviewSessionPayload(action.payloadJson);
        if (payload === null) {
          log.error({ sessionActionId: action.id }, "invalid interview payload; discarding");
          deps.store.markActionDone(action.id);
          continue;
        }
        return { id: action.id, payload };
      }
      return null;
    },
  };
}
