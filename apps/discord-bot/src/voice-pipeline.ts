/**
 * voice-memo パイプライン(design.md §6.4 ③-b / ADR-0015 D4-D5)。
 * pending_actions(type "voice_memo")を直列に消費し、
 * 音声ダウンロード → STT(OpenAI・PR-V2)→ 草案(capture/draft.md 流用)→
 * 原本 + 記事 + 採番を 1 本の単発 PR(voice-memo/<messageId>)→ スレッド返信 + DM。
 * マージは既存の DM 👍 代理マージ(handleProxyMergeReaction)がそのまま効く。
 *
 * 障害の扱い(D5): 一時的な失敗(429/529/timeout/ネットワーク)は pending を残して静かに終える
 * (次の kick/再起動で再試行)。恒久的な失敗(添付 URL 失効・4xx・空の文字起こし)は投稿者へ
 * 返信して done にする(無限リトライでエラー返信を繰り返さない)。
 */
import type { GhClient } from "@stratum/gh-client";
import { GhClientError } from "@stratum/gh-client";
import { buildVoiceMemoDoc, type Source, serializeEntry, voiceMemoPath } from "@stratum/kb-core";
import type { PromptStore } from "@stratum/llm";
import { LlmError, RETRYABLE_LLM_CODES, type Transcriber } from "@stratum/llm";
import type { Logger } from "pino";
import {
  allocateCaptureId,
  buildCaptureEntry,
  type DraftSearchFn,
  jstDayKey,
  runDraft,
} from "./capture.js";
import { SerialQueue } from "./concurrency.js";
import { githubForDiscord, type MembersConfig, type OpsConfig } from "./config.js";
import type { BotStore } from "./db.js";
import { withCorrelation } from "./logger.js";
import { VOICE_MEMO_ACTION_TYPE, voiceMemoPayloadSchema } from "./voice.js";

/** 冪等キーとなるブランチ名(capture/<id> と同型・ADR-0015 D4)。 */
export function voiceMemoBranch(messageId: string): string {
  return `voice-memo/${messageId}`;
}

/** Discord への返信・DM(discord.js から剥がした seam。テストは配列に積む fake)。 */
export interface VoiceMessenger {
  reply(channelId: string, messageId: string, content: string): Promise<void>;
  dm(userId: string, content: string): Promise<void>;
}

export interface VoicePipelineDeps {
  logger: Logger;
  store: BotStore;
  members: MembersConfig;
  /** kb_repo(書き込み先)。null なら機能 OFF(capture と同じゲート)。 */
  ops?: OpsConfig;
  gh?: GhClient;
  promptStore?: PromptStore;
  /** Agent SDK の cwd(草案はツール無し単発だが必須項目)。 */
  cwd: string;
  /** STT(PR-V2)。undefined = OFF(OPENAI_API_KEY 未設定)。 */
  transcriber?: Transcriber;
  messenger: VoiceMessenger;
  /** 音声ダウンロード(テスト差し替え)。 */
  fetchFn?: typeof fetch;
  /** テスト用 seam(既定=実 runAgentSearch)。 */
  draftSearch?: DraftSearchFn;
  now?: () => Date;
}

/** 一時的(リトライ可能)な失敗か。pending を残す判定(D5)。 */
function isTransient(err: unknown): boolean {
  return err instanceof LlmError && RETRYABLE_LLM_CODES.includes(err.code);
}

const TRANSCRIBE_FAILED_MESSAGE = "音声の文字起こしに失敗しました。もう一度投稿してみてください。";
const EMPTY_TRANSCRIPT_MESSAGE =
  "文字起こし結果が空でした(無音の可能性)。もう一度投稿してみてください。";

/**
 * pending の voice_memo を古い順にすべて処理する(直列)。
 * 機能に必要な依存(kb_repo / gh / promptStore / transcriber)が欠けている間は何もしない
 * (pending は残る = 設定が揃った後の再起動で処理される)。
 */
export async function processVoiceMemoQueue(deps: VoicePipelineDeps): Promise<void> {
  const { ops, gh, promptStore, transcriber } = deps;
  if (
    ops === undefined ||
    ops.kb_repo === null ||
    gh === undefined ||
    promptStore === undefined ||
    transcriber === undefined
  ) {
    return; // 機能 OFF(設定・認証・STT キーのいずれかが無い)
  }
  const pending = deps.store
    .listPendingActions(VOICE_MEMO_ACTION_TYPE)
    .filter((a) => a.state === "pending");
  for (const action of pending) {
    await processOne(action.id, action.payloadJson, {
      ...deps,
      ops,
      gh,
      promptStore,
      transcriber,
    });
  }
}

type ReadyDeps = VoicePipelineDeps & {
  ops: OpsConfig;
  gh: GhClient;
  promptStore: PromptStore;
  transcriber: Transcriber;
};

async function processOne(
  actionId: string,
  payloadJson: string | null,
  deps: ReadyDeps,
): Promise<void> {
  const log = withCorrelation(deps.logger, `voice:${actionId}`);
  const kbRepo = deps.ops.kb_repo as string;

  // payload の検証。壊れた行は再試行しても直らないため done にして飛ばす。
  const parsed = voiceMemoPayloadSchema.safeParse(
    payloadJson === null ? null : JSON.parse(payloadJson),
  );
  if (!parsed.success) {
    log.error({ err: parsed.error }, "invalid voice_memo payload; skipping");
    deps.store.markActionDone(actionId);
    return;
  }
  const payload = parsed.data;

  try {
    // 冪等: 同一メッセージの既存 PR(open/closed 問わず)があれば作り直さない
    // (PR 作成後・markActionDone 前にクラッシュしたケースのレジューム)。
    const head = voiceMemoBranch(payload.messageId);
    const existing = (await deps.gh.listPullRequests(kbRepo, { state: "all" })).find(
      (p) => p.headRef === head,
    );
    if (existing !== undefined) {
      log.info({ pr: existing.number }, "voice memo PR already exists");
      deps.store.markActionDone(actionId);
      return;
    }

    // 音声ダウンロード。CDN URL は期限付きのため、4xx は恒久失敗として案内する。
    const fetchFn = deps.fetchFn ?? fetch;
    let audio: Uint8Array;
    try {
      const res = await fetchFn(payload.attachmentUrl);
      if (!res.ok) {
        log.warn({ status: res.status }, "attachment download failed (permanent)");
        await deps.messenger.reply(payload.channelId, payload.messageId, TRANSCRIBE_FAILED_MESSAGE);
        deps.store.markActionDone(actionId);
        return;
      }
      audio = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      log.warn({ err }, "attachment download failed (transient); will retry");
      return; // 一時的なネットワーク失敗 → pending を残す
    }

    // STT(§7.1 リトライは Transcriber 内)。
    let transcript: string;
    let sttModel: string;
    try {
      const result = await deps.transcriber({
        audio,
        filename: payload.attachmentName ?? "voice-memo.ogg",
        ...(payload.contentType !== null ? { contentType: payload.contentType } : {}),
      });
      transcript = result.text;
      sttModel = result.model;
    } catch (err) {
      if (isTransient(err)) {
        log.warn({ err }, "STT transient failure; will retry");
        return; // pending を残す(エラー返信は繰り返さない)
      }
      log.error({ err }, "STT permanent failure");
      await deps.messenger.reply(payload.channelId, payload.messageId, TRANSCRIBE_FAILED_MESSAGE);
      deps.store.markActionDone(actionId);
      return;
    }
    if (transcript.trim().length === 0) {
      await deps.messenger.reply(payload.channelId, payload.messageId, EMPTY_TRANSCRIPT_MESSAGE);
      deps.store.markActionDone(actionId);
      return;
    }

    const now = deps.now?.() ?? new Date();
    const dateJst = jstDayKey(now);
    const owner = githubForDiscord(deps.members, payload.authorId) ?? "unassigned";

    // 草案(capture/draft.md 流用・standard)。入力は文字起こし全文。
    const candidate = await runDraft(
      { context: `${owner}(音声メモ): ${transcript}`, cwd: deps.cwd },
      {
        promptStore: deps.promptStore,
        ...(deps.draftSearch ? { search: deps.draftSearch } : {}),
      },
    );

    // 原本 + 記事 + 採番を 1 PR に同梱(ADR-0015 D4)。
    const transcriptPath = voiceMemoPath(dateJst, payload.messageId);
    const doc = buildVoiceMemoDoc({
      transcript,
      messageUrl: payload.messageUrl,
      author: owner,
      dateJst,
      sttModel,
    });
    const { id, counterJson } = await allocateCaptureId(deps.gh, kbRepo, now);
    const built = buildCaptureEntry(id, candidate, payload.messageUrl, owner, now);
    // 出典は原本(kind: voice-memo)+ 元メッセージの permalink(P2)。
    const sources: Source[] = [
      { kind: "voice-memo", repo: kbRepo, path: transcriptPath },
      { kind: "discord", url: payload.messageUrl },
    ];
    const pr = await deps.gh.createPullRequest({
      repo: kbRepo,
      head,
      title: `docs(kb): voice-memo — ${candidate.title}`,
      body: [
        "音声メモからナレッジ記事を起こしました(§6.4 ③-b / ADR-0015)。",
        "",
        `- 元メッセージ: ${payload.messageUrl}`,
        `- 原本(文字起こし全文): \`${transcriptPath}\``,
        `- 投稿者: <@${payload.authorId}>(👍 は本人の DM から)`,
        "",
        "スキーマ検証はこのリポの validate CI が行います。",
      ].join("\n"),
      files: [
        { path: transcriptPath, content: doc },
        {
          path: built.path,
          content: serializeEntry({
            frontmatter: { ...built.frontmatter, sources },
            body: built.body,
          }),
        },
        { path: "_meta/id-counter.json", content: counterJson },
      ],
    });

    // 「こう記録しました」スレッド返信(§6.4 L485)+ 本人 DM(👍 でマージ)。
    const excerpt = transcript.trim().slice(0, 200);
    await deps.messenger.reply(
      payload.channelId,
      payload.messageId,
      [
        `🎙️ こう記録しました(冒頭): ${excerpt}${transcript.trim().length > 200 ? "…" : ""}`,
        `原本と記事の PR: ${pr.url}`,
        "訂正がある場合はこの返信にリプライしてください。",
      ].join("\n"),
    );
    try {
      await deps.messenger.dm(
        payload.authorId,
        [
          `🎙️ 音声メモをナレッジ化する PR を作成しました: ${pr.url}`,
          "内容を確認して、この DM に 👍 を付けるとマージされます。修正したい場合は PR を直接編集してください。",
        ].join("\n"),
      );
    } catch (err) {
      log.warn({ err }, "DM 送信に失敗(受信拒否設定の可能性)");
    }
    deps.store.markActionDone(actionId);
    log.info({ pr: pr.number, id }, "voice memo PR created");
  } catch (err) {
    if (err instanceof GhClientError && err.code === "CONFLICT") {
      // ブランチ既存(ほぼ同時の二重処理)。冪等扱いで done に。
      log.warn({ err }, "voice memo PR already exists (conflict)");
      deps.store.markActionDone(actionId);
      return;
    }
    if (isTransient(err)) {
      log.warn({ err }, "voice memo transient failure; will retry");
      return; // pending を残す
    }
    // 想定外は pending を残しつつログ(次回 kick で再試行。連続失敗は運用ログで気づく)。
    log.error({ err }, "voice memo processing failed");
  }
}

/**
 * 直列ワーカー。kick() は多重に呼ばれても 1 本ずつ順に drain する(SerialQueue)。
 * 呼び出し元: 受付直後(discord.ts)と起動時レジューム(index.ts)。
 */
export function createVoiceMemoWorker(deps: VoicePipelineDeps): { kick(): void } {
  const queue = new SerialQueue();
  return {
    kick() {
      void queue
        .enqueue(() => processVoiceMemoQueue(deps))
        .catch((err) => {
          withCorrelation(deps.logger, "voice-worker").error({ err }, "voice memo queue failed");
        });
    },
  };
}
