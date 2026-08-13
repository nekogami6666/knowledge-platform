/**
 * /interview start・status・cancel のハンドラ(ADR-0028 D5 / design.md §6.6 ⑤-b)。
 * セッションの契約と状態機械は interview-session.ts、録音制御は vc-recorder.ts が持ち、
 * ここはコマンド入力 → セッション作成(pending_actions "armed")/ 表示 / 中止だけを担う。
 * 「検証済み入力 → 実行 → 応答文字列」は interaction 非依存の純コア関数
 * (startInterviewCore / statusInterviewCore / cancelInterviewCore)に抽出し、
 * スラコマハンドラと面談パネル(interview-panel.ts)が同じコアを共有する。
 * 判定は純関数(interviewStartDecision)に抽出して単体テストする(CLAUDE.md §12.2)。
 * discord.js への依存は interaction の reply/options のみ(テストは fake interaction)。
 */
import type { GhClient } from "@stratum/gh-client";
import {
  githubForDiscord,
  INTERVIEW_KITS_DIR,
  interviewKitPath,
  type Members,
  nameForDiscord,
} from "@stratum/kb-core";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Logger } from "pino";
import type { BotStore } from "./db.js";
import {
  findActiveInterviewSession,
  INTERVIEW_SESSION_ACTION_TYPE,
  type InterviewSessionPayload,
} from "./interview-session.js";
import { withCorrelation } from "./logger.js";
import { isoJst } from "./time.js";

export interface InterviewCommandDeps {
  store: BotStore;
  /** 専用 VC(voice.yaml vc_channel_id)。/interview は VC 録音が有効な環境でのみ配線される。 */
  voiceVcChannelId: string;
  /** キット存在確認(gh.getFileContents)。未設定なら確認をスキップする。 */
  gh?: GhClient;
  /** キット存在確認先(ops.kb_repo)。未設定なら確認をスキップする。 */
  kbRepo?: string;
  /** "armed" の失効(分・voice.yaml interview_arm_ttl_minutes)。 */
  armTtlMinutes: number;
  /** 自動チャンク分割の上限(分・voice.yaml max_recording_minutes。開始案内の文言に使う)。 */
  maxRecordingMinutes: number;
  /** 通常 VC 録音が進行中か(vc-recorder watcher の hasActive)。 */
  hasActiveRecording(): boolean;
  /** 進行中の録音を破棄する(vc-recorder watcher の abortActive。cancel が使う)。 */
  abortActiveRecording(reason: string): Promise<void>;
  makeId(): string;
  now(): Date;
  logger: Logger;
}

// --- 判定(純関数)---

export interface InterviewStartInput {
  /** アクティブ(armed | recording)なセッションが既にあるか(ADR-0028 D5: 全体で 1 件)。 */
  hasActiveSession: boolean;
  /** 通常 VC 録音が進行中か(D5: 録音に後からセッションを被せない)。 */
  recordingActive: boolean;
  /** VC 録音機能(voice.vc_channel_id + RECORDER_URL)が有効か。 */
  vcConfigured: boolean;
}

export type InterviewStartDecision = { ok: true } | { ok: false; reason: string };

/** /interview start のガード判定(ADR-0028 D5・純関数)。 */
export function interviewStartDecision(input: InterviewStartInput): InterviewStartDecision {
  if (!input.vcConfigured) {
    return {
      ok: false,
      reason:
        "この環境では VC 録音が無効のため /interview を利用できません(voice.vc_channel_id と RECORDER_URL の設定が必要です)。",
    };
  }
  if (input.hasActiveSession) {
    return {
      ok: false,
      reason:
        "進行中の interview セッションが既にあります(同時に有効なのは 1 件・ADR-0028 D5)。/interview status で確認し、/interview cancel で中止できます。",
    };
  }
  if (input.recordingActive) {
    return {
      ok: false,
      reason:
        "通常の VC 録音が進行中のため開始できません。録音の終了(全員退室)を待ってからもう一度実行してください。",
    };
  }
  return { ok: true };
}

// --- kit 解決 ---

/** 明示 kit オプションに `interviews/kits/` 前置を強制する(リポ外パスの指定を防ぐ)。 */
export function normalizeKitOption(kit: string): string {
  const trimmed = kit.trim().replace(/^\/+/, "");
  return trimmed.startsWith(`${INTERVIEW_KITS_DIR}/`)
    ? trimmed
    : `${INTERVIEW_KITS_DIR}/${trimmed}`;
}

/**
 * 使用する質問キットのパスを解決する(ADR-0028 D4 のキット参照)。
 * 明示 kit(前置強制・main の存在確認)→ 自動発見 interviewKitPath(person, topic) の存在確認 →
 * どちらも無ければ null(キット無しで開始)。gh / kbRepo 未設定なら存在確認をスキップ
 * (明示パスをそのまま採用・自動発見は null)。存在確認の失敗(一時障害)は開始を妨げない。
 */
export async function resolveKitPath(
  input: { kitOption: string | null; person: string; topic: string },
  deps: Pick<InterviewCommandDeps, "gh" | "kbRepo" | "logger">,
): Promise<string | null> {
  const explicit = input.kitOption === null ? null : normalizeKitOption(input.kitOption);
  const { gh, kbRepo } = deps;
  if (gh === undefined || kbRepo === undefined) return explicit;
  const exists = (path: string): Promise<boolean> =>
    gh.getFileContents({ repo: kbRepo, path }).then((f) => f !== null);
  try {
    if (explicit !== null && (await exists(explicit))) return explicit;
    const auto = interviewKitPath(input.person, input.topic);
    if (await exists(auto)) return auto;
    return null;
  } catch (err) {
    // 存在確認の一時失敗でセッション開始を止めない(明示パスは無確認で採用)。
    deps.logger.warn({ err }, "kit の存在確認に失敗したためスキップします");
    return explicit;
  }
}

// --- person 解決 ---

/**
 * Discord ユーザ ID → セッション payload の person 表記(パネルの UserSelectMenu 用)。
 * GitHub ユーザ名(人物識別子の正・§4.2)→ 表示名(ADR-0022)→ 生 ID の順にフォールバックする。
 * members 対応表は KB の _meta/members.yaml が唯一の正(members.ts の MembersLoader seam)。
 */
export function resolvePersonDisplay(members: Members, discordUserId: string): string {
  return (
    githubForDiscord(members, discordUserId) ??
    nameForDiscord(members, discordUserId) ??
    discordUserId
  );
}

// --- コア(interaction 非依存。スラコマとパネルが共有する)---

/** コアの実行結果。message はそのまま ephemeral 応答に使える日本語文字列。 */
export interface InterviewCoreResult {
  ok: boolean;
  message: string;
}

const NO_ACTIVE_SESSION_MESSAGE = "進行中のセッションはありません。";
const GUILD_ONLY_MESSAGE = "/interview はサーバー内でのみ利用できます。";

/** startInterviewCore の検証済み入力(guild 内であることは呼び手が確認する)。 */
export interface StartInterviewCoreInput {
  /** 対象者の表記(スラコマは自由入力・パネルは resolvePersonDisplay の解決結果)。 */
  person: string;
  topic: string;
  /** 明示 kit オプション(スラコマの kit。パネルは null = 自動発見のみ)。 */
  kitOption: string | null;
  guildId: string;
  /** 開始操作をした人(= owner・完了 PR の DM 先)。 */
  starterId: string;
}

/**
 * セッション開始のコア: ガード判定 → キット解決 → pending_actions "armed" 投入 → 案内文。
 * 拒否(ok: false)はガードの reason をそのまま返す(store には何も書かない)。
 */
export async function startInterviewCore(
  input: StartInterviewCoreInput,
  deps: InterviewCommandDeps,
): Promise<InterviewCoreResult> {
  const now = deps.now();
  const decision = interviewStartDecision({
    hasActiveSession: findActiveInterviewSession(deps.store, now, deps.armTtlMinutes) !== null,
    recordingActive: deps.hasActiveRecording(),
    vcConfigured: deps.voiceVcChannelId.length > 0,
  });
  if (!decision.ok) return { ok: false, message: decision.reason };

  const kitPath = await resolveKitPath(
    { kitOption: input.kitOption, person: input.person, topic: input.topic },
    deps,
  );

  const sessionId = deps.makeId();
  const payload: InterviewSessionPayload = {
    sessionId,
    person: input.person,
    topic: input.topic,
    kitPath,
    guildId: input.guildId,
    channelId: deps.voiceVcChannelId,
    starterId: input.starterId,
    participantIds: [],
    chunks: [],
    currentChunk: null,
    startedAtJst: isoJst(now),
  };
  deps.store.queueAction({
    id: deps.makeId(),
    type: INTERVIEW_SESSION_ACTION_TYPE,
    queryId: null,
    payloadJson: JSON.stringify(payload),
    state: "armed", // ADR-0028 D1 の初期状態(録音前。VC 入室で "recording" へ)
    createdAt: isoJst(now),
  });

  withCorrelation(deps.logger, `interview:${sessionId}`).info(
    { person: input.person, topic: input.topic, kitPath, starterId: input.starterId },
    "interview session armed",
  );
  return {
    ok: true,
    message: [
      `🎤 interview セッションを受け付けました: ${input.person} × ${input.topic}`,
      kitPath !== null
        ? `- 質問キット: \`${kitPath}\``
        : "- 質問キットが見つからないため、キット無しで開始します",
      `- <#${deps.voiceVcChannelId}> に入ると録音を開始します(${deps.maxRecordingMinutes} 分ごとに自動分割・境界で数秒欠けることがあります)`,
      "- 全員が退室するとセッション完了 → 文字起こしの PR を DM でお知らせします",
      `- ${deps.armTtlMinutes} 分以内に誰も入室しない場合は自動キャンセルされます`,
      "- 中止する場合は /interview cancel",
    ].join("\n"),
  };
}

/** 状態表示のコア(読み取りのみ)。セッション無しは ok: false + 案内文。 */
export function statusInterviewCore(deps: InterviewCommandDeps): InterviewCoreResult {
  const now = deps.now();
  const active = findActiveInterviewSession(deps.store, now, deps.armTtlMinutes);
  if (active === null) return { ok: false, message: NO_ACTIVE_SESSION_MESSAGE };
  const p = active.payload;
  const elapsedMin = Math.max(0, Math.floor((now.getTime() - Date.parse(p.startedAtJst)) / 60_000));
  const lines = [
    `🎤 interview セッション: ${p.person} × ${p.topic}`,
    `- 状態: ${active.state === "armed" ? "armed(VC 入室待ち)" : "recording(録音中)"}`,
    `- チャンク: ${p.chunks.length} 本${p.currentChunk !== null ? `(+ 録音中 seq ${p.currentChunk.seq})` : ""}`,
    `- 経過: ${elapsedMin} 分`,
    `- 質問キット: ${p.kitPath !== null ? `\`${p.kitPath}\`` : "無し"}`,
  ];
  if (active.state === "armed") {
    lines.push(`- 自動キャンセルまで: 残り ${Math.max(0, deps.armTtlMinutes - elapsedMin)} 分`);
  }
  return { ok: true, message: lines.join("\n") };
}

/** 中止のコア: recording なら録音 abort(チャンクは欠番)→ "cancelled" へ。 */
export async function cancelInterviewCore(
  deps: InterviewCommandDeps,
): Promise<InterviewCoreResult> {
  const active = findActiveInterviewSession(deps.store, deps.now(), deps.armTtlMinutes);
  if (active === null) return { ok: false, message: NO_ACTIVE_SESSION_MESSAGE };
  if (active.state === "recording") {
    // 進行中の録音を破棄(interview チャンクは欠番扱い・ADR-0028 D5)。
    await deps.abortActiveRecording("interview cancel");
  }
  deps.store.setActionState(active.id, "cancelled");
  withCorrelation(deps.logger, `interview:${active.payload.sessionId}`).info(
    { state: active.state },
    "interview session cancelled",
  );
  return {
    ok: true,
    message: `🛑 interview セッション(${active.payload.person} × ${active.payload.topic})を中止しました。録音済みチャンクは処理されません。`,
  };
}

// --- ハンドラ(interaction グルー)---

async function handleInterviewStart(
  interaction: ChatInputCommandInteraction,
  deps: InterviewCommandDeps,
): Promise<void> {
  // ADR-0018 D4 と同じ: interaction は DM からも届くため guild を明示チェック。
  if (!interaction.inGuild()) {
    await interaction.reply({ content: GUILD_ONLY_MESSAGE, ephemeral: true });
    return;
  }
  const result = await startInterviewCore(
    {
      person: interaction.options.getString("person", true),
      topic: interaction.options.getString("topic", true),
      kitOption: interaction.options.getString("kit"),
      guildId: interaction.guildId,
      starterId: interaction.user.id,
    },
    deps,
  );
  await interaction.reply({ content: result.message, ephemeral: true });
}

async function handleInterviewStatus(
  interaction: ChatInputCommandInteraction,
  deps: InterviewCommandDeps,
): Promise<void> {
  const result = statusInterviewCore(deps);
  await interaction.reply({ content: result.message, ephemeral: true });
}

async function handleInterviewCancel(
  interaction: ChatInputCommandInteraction,
  deps: InterviewCommandDeps,
): Promise<void> {
  const result = await cancelInterviewCore(deps);
  await interaction.reply({ content: result.message, ephemeral: true });
}

/**
 * /interview のサブコマンド分岐(discord.ts の InteractionCreate から呼ばれる)。
 * 例外は handleStats / handleButton と同じ封じ込め(catch → log + 未応答ならガード付き通知)。
 */
export async function handleInterviewCommand(
  interaction: ChatInputCommandInteraction,
  deps: InterviewCommandDeps,
): Promise<void> {
  const log = withCorrelation(deps.logger, "interview");
  try {
    const sub = interaction.options.getSubcommand();
    if (sub === "start") await handleInterviewStart(interaction, deps);
    else if (sub === "status") await handleInterviewStatus(interaction, deps);
    else if (sub === "cancel") await handleInterviewCancel(interaction, deps);
  } catch (err) {
    log.error({ err }, "interview command failed");
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "コマンドの処理に失敗しました。", ephemeral: true });
      } catch {
        // noop: 通知自体が失敗。ログ済み。
      }
    }
  }
}
