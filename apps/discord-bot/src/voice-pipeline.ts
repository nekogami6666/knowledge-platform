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
import { readFile as fsReadFile } from "node:fs/promises";
import type { GhClient } from "@stratum/gh-client";
import { GhClientError } from "@stratum/gh-client";
import {
  buildVoiceMemoDoc,
  githubForDiscord,
  nameForDiscord,
  type Source,
  serializeEntry,
  voiceMemoPath,
} from "@stratum/kb-core";
import type {
  AgentSearchOptions,
  AgentSearchResult,
  LlmDeps,
  PromptStore,
  Transcriber,
} from "@stratum/llm";
import {
  LlmError,
  loadPrompt,
  nullUsageRecorder,
  RETRYABLE_LLM_CODES,
  runAgentSearch,
  withRetry,
} from "@stratum/llm";
import type { Logger } from "pino";
import { z } from "zod";
import {
  allocateCaptureId,
  buildCaptureEntry,
  type CaptureLlmDeps,
  type DraftSearchFn,
  jstDayKey,
  runDraft,
} from "./capture.js";
import { SerialQueue } from "./concurrency.js";
import type { OpsConfig } from "./config.js";
import type { BotStore } from "./db.js";
import { withCorrelation } from "./logger.js";
import type { MembersLoader } from "./members.js";
import {
  VOICE_CORRECTION_ACTION_TYPE,
  VOICE_MEMO_ACTION_TYPE,
  VOICE_REPLY_MARKER,
  voiceCorrectionPayloadSchema,
  voiceMemoPayloadSchema,
} from "./voice.js";

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
  /** owner の写像(KB _meta/members.yaml の都度読み・ADR-0017 D3)。 */
  getMembers: MembersLoader;
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
  /** VC 録音ファイルの読み取り(ADR-0020 D4。共有マウント。テスト差し替え)。 */
  readLocalFile?: (absPath: string) => Promise<Uint8Array>;
  /** テスト用 seam(既定=実 runAgentSearch)。 */
  draftSearch?: DraftSearchFn;
  /** 訂正反映(fast)の seam(PR-V4)。 */
  correctionSearch?: CorrectionSearchFn;
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
  // VC 録音(ADR-0020)か添付(ADR-0015)か。VC は返信先メッセージが無いため案内は本人 DM に送る。
  const isVc = "source" in payload;
  const idemKey = isVc ? payload.meetingId : payload.messageId;
  const notify = (text: string): Promise<void> =>
    "source" in payload
      ? deps.messenger.dm(payload.authorId, text)
      : deps.messenger.reply(payload.channelId, payload.messageId, text);

  try {
    // 冪等: 同一メモの既存 PR(open/closed 問わず)があれば作り直さない
    // (PR 作成後・markActionDone 前にクラッシュしたケースのレジューム)。
    const head = voiceMemoBranch(idemKey);
    const existing = (await deps.gh.listPullRequests(kbRepo, { state: "all" })).find(
      (p) => p.headRef === head,
    );
    if (existing !== undefined) {
      log.info({ pr: existing.number }, "voice memo PR already exists");
      deps.store.markActionDone(actionId);
      return;
    }

    // 音声の入手。添付は CDN からダウンロード(期限付き URL・4xx は恒久失敗)、
    // VC 録音は共有マウントのファイルを読む(欠落 = 恒久失敗・ADR-0020 D4)。
    let audio: Uint8Array;
    if ("source" in payload) {
      try {
        const read =
          deps.readLocalFile ?? (async (p: string) => new Uint8Array(await fsReadFile(p)));
        audio = await read(payload.filePath);
      } catch (err) {
        log.warn({ err, filePath: payload.filePath }, "vc recording file missing (permanent)");
        await notify(TRANSCRIBE_FAILED_MESSAGE);
        deps.store.markActionDone(actionId);
        return;
      }
    } else {
      const fetchFn = deps.fetchFn ?? fetch;
      try {
        const res = await fetchFn(payload.attachmentUrl);
        if (!res.ok) {
          log.warn({ status: res.status }, "attachment download failed (permanent)");
          await notify(TRANSCRIBE_FAILED_MESSAGE);
          deps.store.markActionDone(actionId);
          return;
        }
        audio = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        log.warn({ err }, "attachment download failed (transient); will retry");
        return; // 一時的なネットワーク失敗 → pending を残す
      }
    }

    // STT(§7.1 リトライは Transcriber 内)。
    let transcript: string;
    let sttModel: string;
    try {
      const result = await deps.transcriber(
        "source" in payload
          ? { audio, filename: "recording.m4a", contentType: "audio/mp4" }
          : {
              audio,
              filename: payload.attachmentName ?? "voice-memo.ogg",
              ...(payload.contentType !== null ? { contentType: payload.contentType } : {}),
            },
      );
      transcript = result.text;
      sttModel = result.model;
    } catch (err) {
      if (isTransient(err)) {
        log.warn({ err }, "STT transient failure; will retry");
        return; // pending を残す(エラー返信は繰り返さない)
      }
      log.error({ err }, "STT permanent failure");
      await notify(TRANSCRIBE_FAILED_MESSAGE);
      deps.store.markActionDone(actionId);
      return;
    }
    if (transcript.trim().length === 0) {
      await notify(EMPTY_TRANSCRIPT_MESSAGE);
      deps.store.markActionDone(actionId);
      return;
    }

    const now = deps.now?.() ?? new Date();
    const dateJst = jstDayKey(now);
    const members = await deps.getMembers();
    const owner = githubForDiscord(members, payload.authorId) ?? "unassigned";
    // VC 録音の参照 URL(メッセージ permalink が無いためチャンネルリンク)と参加者 → people 写像(ADR-0020 D3)。
    const linkUrl =
      "source" in payload
        ? `https://discord.com/channels/${payload.guildId}/${payload.channelId}`
        : payload.messageUrl;
    const people =
      "source" in payload
        ? [
            ...new Set(
              payload.participantIds
                .map((d) => githubForDiscord(members, d))
                .filter((v): v is string => v !== undefined),
            ),
          ]
        : [];

    // 草案(capture/draft.md 流用・standard)。入力は文字起こし全文。
    const candidate = await runDraft(
      { context: `${owner}(音声メモ): ${transcript}`, cwd: deps.cwd },
      {
        promptStore: deps.promptStore,
        ...(deps.draftSearch ? { search: deps.draftSearch } : {}),
      },
    );

    // 原本 + 記事 + 採番を 1 PR に同梱(ADR-0015 D4)。
    const transcriptPath = voiceMemoPath(dateJst, idemKey);
    const doc = buildVoiceMemoDoc({
      transcript,
      messageUrl: linkUrl,
      author: owner,
      dateJst,
      sttModel,
    });
    const { id, counterJson } = await allocateCaptureId(deps.gh, kbRepo, now);
    const built = buildCaptureEntry(id, candidate, linkUrl, owner, now);
    // 出典は原本(kind: voice-memo)+ 元メッセージの permalink(P2)。
    // VC 録音は message permalink が無い(discord source の URL 形式を満たせない)ため原本のみ。
    const sources: Source[] = isVc
      ? [{ kind: "voice-memo", repo: kbRepo, path: transcriptPath }]
      : [
          { kind: "voice-memo", repo: kbRepo, path: transcriptPath },
          { kind: "discord", url: linkUrl },
        ];
    const pr = await deps.gh.createPullRequest({
      repo: kbRepo,
      head,
      title: `docs(kb): voice-memo — ${candidate.title}`,
      body: [
        "音声メモからナレッジ記事を起こしました(§6.4 ③-b / ADR-0015)。",
        "",
        `- ${isVc ? "録音元 VC(ADR-0020)" : "元メッセージ"}: ${linkUrl}`,
        `- 原本(文字起こし全文): \`${transcriptPath}\``,
        `- 投稿者: ${nameForDiscord(members, payload.authorId) ?? `<@${payload.authorId}>`}(👍 は本人の DM から)`,
        "",
        "スキーマ検証はこのリポの validate CI が行います。",
      ].join("\n"),
      files: [
        { path: transcriptPath, content: doc },
        {
          path: built.path,
          content: serializeEntry({
            frontmatter: {
              ...built.frontmatter,
              sources,
              ...(people.length > 0 ? { people } : {}),
            },
            body: built.body,
          }),
        },
        { path: "_meta/id-counter.json", content: counterJson },
      ],
    });

    // 「こう記録しました」スレッド返信(§6.4 L485)+ 本人 DM(👍 でマージ)。
    // 先頭マーカー・PR URL・原本パスは訂正検知(voiceCorrectionDecision)が解析する契約。
    // VC 録音は返信先メッセージが無いためスレッド返信をスキップし、DM に冒頭抜粋を含める
    // (訂正フライホイールは添付経路のみ。VC の修正は PR 直接編集・ADR-0020 D4)。
    const excerpt = transcript.trim().slice(0, 200);
    const excerptLine = `(冒頭): ${excerpt}${transcript.trim().length > 200 ? "…" : ""}`;
    if (!("source" in payload)) {
      await deps.messenger.reply(
        payload.channelId,
        payload.messageId,
        [
          `${VOICE_REPLY_MARKER}${excerptLine}`,
          `原本と記事の PR: ${pr.url}`,
          `原本: \`${transcriptPath}\``,
          "訂正がある場合はこの返信にリプライしてください。",
        ].join("\n"),
      );
    }
    try {
      await deps.messenger.dm(
        payload.authorId,
        isVc
          ? [
              `🎙️ VC 録音をナレッジ化する PR を作成しました: ${pr.url}`,
              `記録${excerptLine}`,
              `原本: \`${transcriptPath}\``,
              "内容を確認して、この DM に 👍 を付けるとマージされます。修正したい場合は PR を直接編集してください。",
            ].join("\n")
          : [
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
        .enqueue(async () => {
          await processVoiceMemoQueue(deps);
          await processVoiceCorrectionQueue(deps);
        })
        .catch((err) => {
          withCorrelation(deps.logger, "voice-worker").error({ err }, "voice memo queue failed");
        });
    },
  };
}

// --- 訂正フライホイール(§6.4 ③-b L485 / PR-V4)---

/** prompts/voice/correct.md(fast)の出力契約。 */
export const voiceCorrectionResultSchema = z.object({
  transcript: z.string().min(1),
});
export type VoiceCorrectionResult = z.infer<typeof voiceCorrectionResultSchema>;

export type CorrectionSearchFn = (
  opts: AgentSearchOptions<VoiceCorrectionResult>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<VoiceCorrectionResult>>;

/** 原本 md の文字起こし節の区切り(buildVoiceMemoDoc と対)。 */
const TRANSCRIPT_SECTION = "## 文字起こし\n\n";

/** 訂正反映: 現在の文字起こし + 訂正指示 → 反映後全文(role:fast・ツール無し単発)。 */
export async function runCorrection(
  input: { current: string; instruction: string; cwd: string },
  deps: CaptureLlmDeps<CorrectionSearchFn>,
): Promise<VoiceCorrectionResult> {
  const search: CorrectionSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("voice", "correct", deps.promptStore);
  const r = await withRetry(
    () =>
      search(
        {
          app: "discord-bot",
          role: prompt.role, // prompt frontmatter(fast)。直書きしない
          systemPrompt: prompt.body,
          prompt: [
            "--- 現在の記録ここから ---",
            input.current,
            "--- 現在の記録ここまで ---",
            "",
            "--- 訂正指示ここから ---",
            input.instruction,
            "--- 訂正指示ここまで ---",
          ].join("\n"),
          cwd: input.cwd,
          outputSchema: voiceCorrectionResultSchema,
          allowedTools: [],
          timeoutMs: deps.timeoutMs ?? 60_000,
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
  return r.value;
}

const CORRECTION_CLOSED_MESSAGE =
  "対象の PR は既にマージ/クローズ済みのため自動反映できません。新しいメモとして投稿し直すか、knowledge-base を直接編集してください。";
const CORRECTION_FAILED_MESSAGE = "訂正の自動反映に失敗しました。PR を直接編集してください。";
const CORRECTION_DONE_MESSAGE =
  "✅ 訂正を原本に反映しました。記事本文も直したい場合は PR を直接編集してください。";

/** pending の voice_correction を古い順に処理する(直列)。STT は不要(gh + prompt + Claude)。 */
export async function processVoiceCorrectionQueue(deps: VoicePipelineDeps): Promise<void> {
  const { ops, gh, promptStore } = deps;
  if (ops === undefined || ops.kb_repo === null || gh === undefined || promptStore === undefined) {
    return; // 機能 OFF
  }
  const pending = deps.store
    .listPendingActions(VOICE_CORRECTION_ACTION_TYPE)
    .filter((a) => a.state === "pending");
  for (const action of pending) {
    await processCorrection(action.id, action.payloadJson, { ...deps, ops, gh, promptStore });
  }
}

async function processCorrection(
  actionId: string,
  payloadJson: string | null,
  deps: VoicePipelineDeps & { ops: OpsConfig; gh: GhClient; promptStore: PromptStore },
): Promise<void> {
  const log = withCorrelation(deps.logger, `voice-correction:${actionId}`);
  const kbRepo = deps.ops.kb_repo as string;

  const parsed = voiceCorrectionPayloadSchema.safeParse(
    payloadJson === null ? null : JSON.parse(payloadJson),
  );
  if (!parsed.success) {
    log.error({ err: parsed.error }, "invalid voice_correction payload; skipping");
    deps.store.markActionDone(actionId);
    return;
  }
  const payload = parsed.data;
  const replyToCorrector = (content: string) =>
    deps.messenger.reply(payload.channelId, payload.correctionMessageId, content);

  try {
    // PR がまだ open か(マージ後の原本書き換えは main への直 commit になるため行わない・初期スコープ)。
    const pr = await deps.gh.getPullRequest(kbRepo, payload.prNumber);
    if (pr.merged || pr.state !== "open") {
      await replyToCorrector(CORRECTION_CLOSED_MESSAGE);
      deps.store.markActionDone(actionId);
      return;
    }

    // ブランチ上の現在の原本を読む(訂正の多重反映にも自然に対応)。
    const branch = voiceMemoBranch(payload.originalMessageId);
    const file = await deps.gh.getFileContents({
      repo: kbRepo,
      path: payload.transcriptPath,
      ref: branch,
    });
    const sectionAt = file?.content.indexOf(TRANSCRIPT_SECTION) ?? -1;
    if (file === null || sectionAt < 0) {
      log.error({ path: payload.transcriptPath }, "transcript not found or unexpected format");
      await replyToCorrector(CORRECTION_FAILED_MESSAGE);
      deps.store.markActionDone(actionId);
      return;
    }
    const header = file.content.slice(0, sectionAt + TRANSCRIPT_SECTION.length);
    const current = file.content.slice(sectionAt + TRANSCRIPT_SECTION.length);

    // fast モデルで訂正を反映(§6.4 L485)。
    const corrected = await runCorrection(
      { current: current.trim(), instruction: payload.correction, cwd: deps.cwd },
      {
        promptStore: deps.promptStore,
        ...(deps.correctionSearch ? { search: deps.correctionSearch } : {}),
      },
    );

    // PR ブランチを更新(main には触れない・ADR-0015 D4)。
    await deps.gh.commitFiles({
      repo: kbRepo,
      branch,
      message: `docs(kb): voice-memo 訂正反映(${payload.correctionMessageId})`,
      files: [
        { path: payload.transcriptPath, content: `${header}${corrected.transcript.trim()}\n` },
      ],
    });
    await replyToCorrector(CORRECTION_DONE_MESSAGE);
    deps.store.markActionDone(actionId);
    log.info({ pr: payload.prNumber }, "voice correction applied");
  } catch (err) {
    if (err instanceof GhClientError && (err.code === "CONFLICT" || err.code === "NOT_FOUND")) {
      // ブランチ先端が動いた(手編集)/ PR・ファイルが消えた。自動反映は諦めて案内する。
      await replyToCorrector(CORRECTION_FAILED_MESSAGE).catch(() => {});
      deps.store.markActionDone(actionId);
      return;
    }
    if (isTransient(err)) {
      log.warn({ err }, "voice correction transient failure; will retry");
      return; // pending を残す
    }
    log.error({ err }, "voice correction failed");
  }
}
