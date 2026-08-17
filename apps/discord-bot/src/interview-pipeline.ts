/**
 * interview セッションのパイプライン(ADR-0028 D4 / design.md §6.6 ⑤-b)。
 * pending_actions(type "interview_session"・state "pending")を直列に消費し、
 * チャンク音声(共有マウント)→ STT(チャンク単位・payload にキャッシュ)→ seq 順結合 →
 * セッション原本(interviews/sessions/)1 ファイルの単発 PR → starter へ DM。
 * capture 流用の草案は作らない — マージ後は夜間 extractor が複数記事に自動分割する(D4)。
 * PR の承認は既存の DM 👍 代理マージ(handleProxyMergeReaction の DM ルート)がそのまま効く。
 *
 * 障害の扱いは voice-pipeline と同じ(ADR-0015 D5 の流儀):
 * - 一時的な失敗(429/529/timeout)は pending を残して静かに終える(次の kick で再試行)。
 *   STT 済みチャンクは payload にキャッシュ済みのため再 STT しない(コスト・時間)。
 * - 恒久的な失敗(ファイル欠落・4xx)はチャンク単位のプレースホルダで本文に明示して続行する
 *   (チャンク失敗 ≠ セッション失敗・ADR-0028 D2)。
 */
import { readFile as fsReadFile } from "node:fs/promises";
import type { GhClient } from "@stratum/gh-client";
import { GhClientError } from "@stratum/gh-client";
import { buildInterviewSessionDoc, interviewSessionPath, nameForDiscord } from "@stratum/kb-core";
import type { Transcriber } from "@stratum/llm";
import {
  type DmTarget,
  noticeAllowedOnce,
  notifyUser,
  permanentFailureMessage,
  TRANSIENT_RETRY_MESSAGE,
} from "./ack.js";
import { jstDayKey } from "./capture.js";
import { SerialQueue } from "./concurrency.js";
import {
  INTERVIEW_SESSION_ACTION_TYPE,
  type InterviewChunk,
  type InterviewSessionPayload,
  parseInterviewSessionPayload,
} from "./interview-session.js";
import { withCorrelation } from "./logger.js";
import { isTransient, type VoicePipelineDeps } from "./voice-pipeline.js";

/** 冪等キーとなるブランチ名(voice-memo/<id> と同型・ADR-0028 D4)。 */
export function interviewSessionBranch(sessionId: string): string {
  return `interview/${sessionId}`;
}

/** 恒久失敗チャンクの本文プレースホルダ(ADR-0028 D4。欠けを本文に明示して続行)。 */
export function chunkPlaceholder(seq: number): string {
  return `(チャンク ${seq}: 音声を取得できませんでした)`;
}

export const SESSION_NO_AUDIO_MESSAGE =
  "🎤 interview セッションの録音を取得できませんでした。お手数ですが /interview start からやり直してください。";

/**
 * 依存は voice-pipeline のサブセット(同じ配線を再利用・§12.2)。
 * 草案を作らないため promptStore / cwd / draftSearch は不要。
 */
export type InterviewPipelineDeps = Pick<
  VoicePipelineDeps,
  | "logger"
  | "store"
  | "getMembers"
  | "ops"
  | "gh"
  | "transcriber"
  | "messenger"
  | "readLocalFile"
  | "now"
>;

/**
 * pending の interview_session を古い順にすべて処理する(直列)。
 * 機能に必要な依存(kb_repo / gh / transcriber)が欠けている間は何もしない
 * (pending は残る = 設定が揃った後の再起動で処理される)。
 */
export async function processInterviewSessionQueue(deps: InterviewPipelineDeps): Promise<void> {
  const { ops, gh, transcriber } = deps;
  if (ops === undefined || ops.kb_repo === null || gh === undefined || transcriber === undefined) {
    return; // 機能 OFF(設定・認証・STT キーのいずれかが無い)
  }
  const pending = deps.store
    .listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)
    .filter((a) => a.state === "pending");
  for (const action of pending) {
    await processSession(action.id, action.payloadJson, {
      ...deps,
      gh,
      transcriber,
      kbRepo: ops.kb_repo,
    });
  }
}

type ReadySessionDeps = InterviewPipelineDeps & {
  gh: GhClient;
  transcriber: Transcriber;
  kbRepo: string;
};

async function processSession(
  actionId: string,
  payloadJson: string | null,
  deps: ReadySessionDeps,
): Promise<void> {
  const log = withCorrelation(deps.logger, `interview:${actionId}`);

  // payload の検証。壊れた行は再試行しても直らないため done にして飛ばす(voice-pipeline の作法)。
  const payload = parseInterviewSessionPayload(payloadJson);
  if (payload === null) {
    log.error("invalid interview_session payload; skipping");
    deps.store.markActionDone(actionId);
    return;
  }

  // ADR-0030 D2/D3: 通知先は starter の DM のみ(セッションには元メッセージが無い)。
  const starter: DmTarget = { send: (text: string) => deps.messenger.dm(payload.starterId, text) };
  /** 失敗を starter へ返す。再試行のたびに繰り返さないよう 1日1回に抑える。 */
  const notifyFailure = async (text: string): Promise<void> => {
    const dayKey = jstDayKey(deps.now?.() ?? new Date());
    if (!noticeAllowedOnce(deps.store, `action:${actionId}`, "failure-notice", dayKey)) return;
    await notifyUser({ user: starter }, text, log);
  };

  try {
    // 冪等: 同一セッションの既存 PR(open/closed 問わず)があれば作り直さない
    // (PR 作成後・markActionDone 前にクラッシュしたケースのレジューム)。
    const head = interviewSessionBranch(payload.sessionId);
    const existing = (await deps.gh.listPullRequests(deps.kbRepo, { state: "all" })).find(
      (p) => p.headRef === head,
    );
    if (existing !== undefined) {
      log.info({ pr: existing.number }, "interview session PR already exists");
      deps.store.markActionDone(actionId);
      return;
    }

    // チャンク 0 件は completeSession が cancelled に落とすため通常来ないが、防御的に閉じる。
    if (payload.chunks.length === 0) {
      await notifyUser({ user: starter }, SESSION_NO_AUDIO_MESSAGE, log);
      deps.store.markActionDone(actionId);
      return;
    }

    // STT: transcript 未キャッシュのチャンクだけ実施し、成功のたびに payload へキャッシュする
    // (一時失敗後の再試行で再 STT しない・ADR-0028 D4)。恒久失敗はプレースホルダで続行。
    const read = deps.readLocalFile ?? (async (p: string) => new Uint8Array(await fsReadFile(p)));
    let chunks: InterviewChunk[] = [...payload.chunks].sort((a, b) => a.seq - b.seq);
    const texts = new Map<number, string>();
    for (const chunk of chunks) {
      if (chunk.transcript !== null) {
        texts.set(chunk.seq, chunk.transcript);
        continue;
      }
      let audio: Uint8Array;
      try {
        audio = await read(chunk.filePath);
      } catch (err) {
        // 共有マウントのファイル欠落は恒久失敗(retention 掃除・sidecar 障害)→ 欠けを明示して続行。
        log.warn({ err, seq: chunk.seq, filePath: chunk.filePath }, "chunk file missing; 欠落明示");
        texts.set(chunk.seq, chunkPlaceholder(chunk.seq));
        continue;
      }
      try {
        const result = await deps.transcriber({
          audio,
          filename: "recording.m4a",
          contentType: "audio/mp4",
        });
        texts.set(chunk.seq, result.text);
        chunks = chunks.map((c) =>
          c.seq === chunk.seq ? { ...c, transcript: result.text, sttModel: result.model } : c,
        );
        const cached: InterviewSessionPayload = { ...payload, chunks };
        deps.store.setActionPayload(actionId, JSON.stringify(cached));
      } catch (err) {
        if (isTransient(err)) {
          // pending を残す(キャッシュ済みチャンクは次回スキップされる)。
          log.warn({ err, seq: chunk.seq }, "chunk STT transient failure; will retry");
          return;
        }
        log.error({ err, seq: chunk.seq }, "chunk STT permanent failure; 欠落明示");
        texts.set(chunk.seq, chunkPlaceholder(chunk.seq));
      }
    }

    // seq 順に結合 → 原本ドキュメント(kb-core の規約・ADR-0028 D4)。
    const transcript = chunks.map((c) => texts.get(c.seq) ?? chunkPlaceholder(c.seq)).join("\n\n");
    const sttModel = chunks.map((c) => c.sttModel).find((m) => m !== undefined) ?? "unknown";
    const members = await deps.getMembers();
    const participantIds = [...new Set([...payload.participantIds, payload.starterId])];
    const participants = [...new Set(participantIds.map((d) => nameForDiscord(members, d) ?? d))];
    const now = deps.now?.() ?? new Date();
    const dateJst = jstDayKey(now);
    const path = interviewSessionPath(dateJst, payload.person, payload.topic, payload.sessionId);
    const doc = buildInterviewSessionDoc({
      person: payload.person,
      topic: payload.topic,
      kitPath: payload.kitPath,
      participants,
      dateJst,
      sttModel,
      channelUrl: `https://discord.com/channels/${payload.guildId}/${payload.channelId}`,
      chunkCount: chunks.length,
      transcript,
    });

    // 単発 PR(原本 1 ファイルのみ・草案なし・ADR-0028 D4)。
    const pr = await deps.gh.createPullRequest({
      repo: deps.kbRepo,
      head,
      title: `docs(kb): インタビュー ${payload.person} × ${payload.topic}(セッション原本)`,
      body: [
        "interview セッションの文字起こし原本です(ADR-0028 D4 / §6.6 ⑤-b)。",
        "",
        `- 対象者 × テーマ: ${payload.person} × ${payload.topic}`,
        ...(payload.kitPath !== null ? [`- 質問キット: \`${payload.kitPath}\``] : []),
        `- 原本: \`${path}\`(チャンク ${chunks.length} 本を seq 順に結合)`,
        `- 開始者: ${nameForDiscord(members, payload.starterId) ?? `<@${payload.starterId}>`}(👍 は本人の DM から)`,
        "",
        "マージ後、夜間の extractor が複数ナレッジ記事に自動分割します。",
        "スキーマ検証はこのリポの validate CI が行います。",
      ].join("\n"),
      files: [{ path, content: doc }],
    });

    // starter へ DM(既存の DM 👍 代理マージ導線がそのまま効く)。DM が閉じている場合は
    // 返信先が無いため届かない — その事実は warn ログに残る(ADR-0030 D2 の限界)。
    await notifyUser(
      { user: starter },
      [
        `🎤 インタビュー(${payload.person} × ${payload.topic})の文字起こし PR を作成しました: ${pr.url}`,
        `原本: \`${path}\``,
        "内容を確認して、この DM に 👍 を付けるとマージできます。マージ後は夜間の extractor が複数のナレッジ記事に自動分割します。",
      ].join("\n"),
      log,
    );
    deps.store.markActionDone(actionId);
    log.info({ pr: pr.number, path }, "interview session PR created");
  } catch (err) {
    if (err instanceof GhClientError && err.code === "CONFLICT") {
      // ブランチ既存(ほぼ同時の二重処理)。冪等扱いで done に。
      log.warn({ err }, "interview session PR already exists (conflict)");
      deps.store.markActionDone(actionId);
      return;
    }
    if (isTransient(err)) {
      log.warn({ err }, "interview session transient failure; will retry");
      // pending は残る = 自動再試行される(ADR-0030 D3)。連投しないよう 1日1回だけ伝える。
      await notifyFailure(TRANSIENT_RETRY_MESSAGE);
      return;
    }
    // 想定外は pending を残しつつログ(次回 kick で再試行。連続失敗は運用ログで気づく)。
    log.error({ err }, "interview session processing failed");
    await notifyFailure(permanentFailureMessage(err));
  }
}

/**
 * 直列ワーカー(voice-pipeline の createVoiceMemoWorker と同型)。
 * kick() は多重に呼ばれても 1 本ずつ順に drain する。呼び出し元は index.ts の合成 kick
 * (voice worker と同じ受付 hook・起動時レジューム・completeSession の onQueued)。
 */
export function createInterviewSessionWorker(deps: InterviewPipelineDeps): { kick(): void } {
  const queue = new SerialQueue();
  return {
    kick() {
      void queue
        .enqueue(() => processInterviewSessionQueue(deps))
        .catch((err) => {
          withCorrelation(deps.logger, "interview-worker").error(
            { err },
            "interview session queue failed",
          );
        });
    },
  };
}
