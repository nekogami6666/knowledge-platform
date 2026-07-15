/**
 * 💡 reaction capture(design.md §6.4 ③-a / PR-E1a)。
 * 任意のメッセージに 💡 が付いたら文脈(スレッド or 前後20件)を収集し、fast で門番(triage)→
 * 成立時のみ standard で草案(draft)→ knowledge-base へ単発 PR → 起票者へ DM(PR リンク +
 * 「👍 でマージ」)。DM 内 👍 の代理マージは PR-E1b(discord.ts の proxyMergeDecision 拡張)。
 *
 * - bot は KB を clone しない: 採番は gh.getFileContents で読んだ counter を in-memory 採番し
 *   更新後 counter を PR に同梱(IdCounterStore は GitHub 結合前提の CAS 抽象・id-allocator.ts)。
 *   並行 capture の競合は 2 本目の PR が id-counter.json で conflict → mergeableState!=clean →
 *   既存の代理マージガード(ADR-0004 D2)が自然に拒否する。
 * - スキーマ検証は KB リポの validate CI に委ねる(validateRepo しない。⑳ 決定)。
 * - 乱用対策: channels.yaml allowlist(§9.3・DM/未許可チャンネル対象外)+ fast 門番 + user 日3件。
 * - 冪等: ブランチ `capture/<messageId>`(既存 PR があれば再作成せず DM 案内)。
 */
import { type GhClient, GhClientError } from "@stratum/gh-client";
import {
  allocateId,
  githubForDiscord,
  type IdCounterStore,
  type KnowledgeEntry,
  serializeEntry,
} from "@stratum/kb-core";
import {
  type AgentSearchOptions,
  type AgentSearchResult,
  type LlmDeps,
  loadPrompt,
  nullUsageRecorder,
  type PromptStore,
  type RetryOptions,
  runAgentSearch,
  type UsageRecorder,
  withRetry,
} from "@stratum/llm";
import type {
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import type { Logger } from "pino";
import { z } from "zod";
import {
  type ChannelGateInput,
  type ChannelsConfig,
  isChannelAllowed,
  type OpsConfig,
} from "./config.js";
import type { BotStore } from "./db.js";
import { withCorrelation } from "./logger.js";
import type { MembersLoader } from "./members.js";
import { gateInputFromChannel } from "./visibility.js";

// --- 中間スキーマ(LLM 出力契約。kb entry の再定義ではない・.default() 禁止=candidate.ts 方針)---

/** 門番(prompts/capture/triage.md・fast)の出力。 */
export const triageResultSchema = z.object({
  capture: z.boolean(),
  reason: z.string(),
});
export type TriageResult = z.infer<typeof triageResultSchema>;

/** 草案(prompts/capture/draft.md・standard)の出力。gap の answerEntryCandidate と同方針。 */
export const captureCandidateSchema = z.object({
  title: z.string().min(1),
  entryType: z.enum(["fact", "procedure", "learning", "failure"]),
  domain: z.string().regex(/^[a-z0-9-]+$/),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  confidence: z.enum(["high", "medium", "low"]),
  slug: z.string().optional(),
});
export type CaptureCandidate = z.infer<typeof captureCandidateSchema>;

// --- 純関数(単体テスト対象)---

/** user 日3件(§6.4 / ⑳ 乱用対策)。 */
export const CAPTURE_DAILY_LIMIT = 3;

/** rate_limits の日次バケットキー(JST 日付・§7.5)。 */
export function jstDayKey(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 冪等キーとなるブランチ名(同一メッセージの 💡 は同じブランチ)。 */
export function captureBranch(messageId: string): string {
  return `capture/${messageId}`;
}

/** 捕捉可否の判定入力(discord.js から必要な値だけを剥がした純粋データ)。 */
export interface CaptureDecisionInput {
  emojiName: string | null;
  reactorIsBot: boolean;
  /** guild メッセージか(DM・グループ DM は §6.4 で対象外)。 */
  inGuild: boolean;
  gate: ChannelGateInput;
  channels: ChannelsConfig;
}

export type CaptureDecision = { capture: true } | { capture: false; reason: string };

/** 💡 捕捉のガード判定(§6.4・純関数)。💡 / 人間 / guild / bot 可視チャンネル(ADR-0018)を満たすときのみ可。 */
export function captureDecision(input: CaptureDecisionInput): CaptureDecision {
  if (input.emojiName !== "💡") return { capture: false, reason: "not-lightbulb" };
  if (input.reactorIsBot) return { capture: false, reason: "bot-reactor" };
  if (!input.inGuild) return { capture: false, reason: "not-guild" };
  if (!isChannelAllowed(input.channels, input.gate)) {
    return { capture: false, reason: "channel-not-allowed" };
  }
  return { capture: true };
}

/** JST(+09:00)の YYYY-MM-DD(kb-core の採番年基準に合わせる)。 */
function isoDateJst(d: Date): string {
  return jstDayKey(d);
}

/** ASCII kebab スラッグ(日本語 title は空になるため "entry" フォールバック)。 */
function slugOf(c: CaptureCandidate): string {
  const s = (c.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "entry";
}

export interface BuiltCaptureEntry {
  /** review_interval_days は type 別デフォルトを serializeEntry/parse が適用するため省略。 */
  frontmatter: Omit<KnowledgeEntry, "review_interval_days">;
  body: string;
  /** knowledge/<domain>/<id>-<slug>.md(repo 相対)。 */
  path: string;
}

/**
 * 草案 → KnowledgeEntry(§4.2)。出典 = 💡 が付いた元メッセージの Discord permalink 1 件(P2)。
 * owner = リアクションした本人の GitHub 名(未マップは呼び出し側が "unassigned" を渡す)。
 */
export function buildCaptureEntry(
  id: string,
  candidate: CaptureCandidate,
  sourceUrl: string,
  owner: string,
  now: Date,
): BuiltCaptureEntry {
  const today = isoDateJst(now);
  const frontmatter: Omit<KnowledgeEntry, "review_interval_days"> = {
    id: id as KnowledgeEntry["id"],
    title: candidate.title,
    type: candidate.entryType,
    domain: candidate.domain,
    tags: [...(candidate.tags ?? [])],
    sources: [{ kind: "discord", url: sourceUrl }],
    people: [owner],
    confidence: candidate.confidence,
    status: "active",
    created: today,
    last_verified: today,
    owner,
  };
  const body = `\n## 概要\n${candidate.body}\n`;
  const path = `knowledge/${candidate.domain}/${id}-${slugOf(candidate)}.md`;
  return { frontmatter, body, path };
}

/**
 * clone なしの kb- 採番: counter を GitHub から読み、in-memory 採番して更新後 JSON を返す
 * (PR に同梱する。ローカル書き込みはしない)。counter 未作成の repo では {} から開始。
 */
export async function allocateCaptureId(
  gh: GhClient,
  repo: string,
  now: Date,
): Promise<{ id: string; counterJson: string }> {
  const file = await gh.getFileContents({ repo, path: "_meta/id-counter.json" });
  type Counters = Awaited<ReturnType<IdCounterStore["load"]>>["counters"];
  let counters: Counters = file === null ? {} : (JSON.parse(file.content) as Counters);
  const store: IdCounterStore = {
    load: async () => ({ counters, version: "pr" }),
    save: async (c) => {
      counters = c;
    },
  };
  const id = await allocateId("kb", store, { now });
  // createLocalIdCounterStore と同じ整形(2 スペース + 末尾改行)で KB 内の diff を安定させる。
  return { id, counterJson: `${JSON.stringify(counters, null, 2)}\n` };
}

// --- LLM ステップ(triage / draft。runAgentSearch は seam)---

export type TriageSearchFn = (
  opts: AgentSearchOptions<TriageResult>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<TriageResult>>;

export type DraftSearchFn = (
  opts: AgentSearchOptions<CaptureCandidate>,
  deps?: LlmDeps,
) => Promise<AgentSearchResult<CaptureCandidate>>;

export interface CaptureLlmDeps<F> {
  promptStore: PromptStore;
  /** runAgentSearch の差し替え(既定=実)。 */
  search?: F;
  usage?: UsageRecorder;
  /** withRetry オプション(既定 maxRetries:1)。 */
  retry?: RetryOptions;
  timeoutMs?: number;
}

export interface CaptureInput {
  /** collectContext が組んだ会話テキスト(★ = 💡 の付いた発言)。 */
  context: string;
  /** Agent SDK の cwd(ツール無し単発だが必須項目。bot は CLONES_DIR)。 */
  cwd: string;
}

/** 会話を user prompt に組み立てる(本文はインライン。ツールで読みにいかない)。 */
export function buildCapturePrompt(context: string): string {
  return [
    "以下は Discord のメッセージ群です。行頭の ★ が 💡 リアクションの付いた発言です。",
    "--- 会話ここから ---",
    context,
    "--- 会話ここまで ---",
  ].join("\n");
}

/** 門番: ナレッジ候補として成立するか(role:fast・ツール無し単発)。 */
export async function runTriage(
  input: CaptureInput,
  deps: CaptureLlmDeps<TriageSearchFn>,
): Promise<TriageResult> {
  const search: TriageSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("capture", "triage", deps.promptStore);
  const r = await withRetry(
    () =>
      search(
        {
          app: "discord-bot",
          role: prompt.role, // prompt frontmatter(fast)。直書きしない
          systemPrompt: prompt.body,
          prompt: buildCapturePrompt(input.context),
          cwd: input.cwd,
          outputSchema: triageResultSchema,
          allowedTools: [],
          timeoutMs: deps.timeoutMs ?? 60_000,
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
  return r.value;
}

/** 草案: 会話 → ナレッジ記事候補(role:standard・ツール無し単発)。 */
export async function runDraft(
  input: CaptureInput,
  deps: CaptureLlmDeps<DraftSearchFn>,
): Promise<CaptureCandidate> {
  const search: DraftSearchFn = deps.search ?? runAgentSearch;
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("capture", "draft", deps.promptStore);
  const r = await withRetry(
    () =>
      search(
        {
          app: "discord-bot",
          role: prompt.role, // prompt frontmatter(standard)。直書きしない
          systemPrompt: prompt.body,
          prompt: buildCapturePrompt(input.context),
          cwd: input.cwd,
          outputSchema: captureCandidateSchema,
          allowedTools: [],
          timeoutMs: deps.timeoutMs ?? 120_000,
        },
        { usage },
      ),
    { maxRetries: 1, ...deps.retry },
  );
  return r.value;
}

// --- 文脈収集 + ハンドラ(グルー。合成テストは fake で)---

/**
 * 💡 メッセージの文脈収集(§6.4 L476)。スレッドならスレッド、通常チャンネルは前後20件。
 * fetch 失敗(権限・削除)は 💡 の付いたメッセージ単体にフォールバック。
 */
export async function collectContext(message: Message): Promise<string> {
  let items: Message[];
  try {
    const channel = message.channel;
    const fetched = channel.isThread()
      ? await channel.messages.fetch({ limit: 50 })
      : await channel.messages.fetch({ around: message.id, limit: 20 });
    items = [...fetched.values()];
    if (!items.some((m) => m.id === message.id)) items.push(message);
  } catch {
    items = [message];
  }
  items.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return items
    .filter((m) => m.content.length > 0)
    .map((m) => {
      const line = `${m.author?.username ?? "?"}: ${m.content}`;
      return m.id === message.id ? `★ ${line}` : line;
    })
    .join("\n");
}

export interface CaptureDeps {
  logger: Logger;
  channels: ChannelsConfig;
  store: BotStore;
  /** owner の写像(KB _meta/members.yaml の都度読み・ADR-0017 D3)。未整備なら空を返すローダ。 */
  getMembers: MembersLoader;
  /** Agent SDK の cwd(ツール無し単発だが必須項目)。bot は CLONES_DIR を渡す。 */
  cwd: string;
  /** kb_repo(書き込み先)。null なら機能 OFF(代理マージと同じゲート・新 config なし)。 */
  ops?: OpsConfig;
  /** GitHub クライアント。認証未整備なら undefined = 機能 OFF。 */
  gh?: GhClient;
  /** プロンプトローダ。未指定なら機能 OFF。 */
  promptStore?: PromptStore;
  /** テスト用 seam(既定=実 runAgentSearch)。 */
  triageSearch?: TriageSearchFn;
  draftSearch?: DraftSearchFn;
  now?: () => Date;
}

/**
 * 💡 リアクション → triage → draft → 単発 PR → DM(§6.4 ③-a)。
 * MessageReactionAdd 全発火に備え、💡 以外は fetch もせず早期 return。
 * 例外は封じ込め(catch → log。リスナを落とさない)。ブランチ既存の CONFLICT は冪等扱い。
 */
export async function handleLightbulb(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  deps: CaptureDeps,
): Promise<void> {
  // 絵文字は partial でも判る。💡 以外(👍 代理マージ等)は REST fetch せず無視。
  if (reaction.emoji.name !== "💡") return;
  const { ops, gh, promptStore } = deps;
  if (ops === undefined || ops.kb_repo === null || gh === undefined || promptStore === undefined) {
    return; // 機能 OFF(設定・認証・プロンプトのいずれかが無い)
  }
  try {
    const r = reaction.partial ? await reaction.fetch() : reaction;
    const message = r.message.partial ? await r.message.fetch() : r.message;
    const reactor = user.partial ? await user.fetch() : user;
    const decision = captureDecision({
      emojiName: r.emoji.name,
      reactorIsBot: reactor.bot,
      inGuild: message.guildId !== null,
      gate: gateInputFromChannel(message.channel, message.channelId),
      channels: deps.channels,
    });
    if (!decision.capture) return; // 対象外(未許可チャンネル・DM 等)には反応しない
    const log = withCorrelation(deps.logger, `capture:${message.id}`);
    const now = deps.now?.() ?? new Date();

    // 乱用対策: user 日3件(§6.4 / ⑳)。超過はチャンネルを汚さず DM で案内。
    const rate = deps.store.hitRateLimit(
      `user:${reactor.id}`,
      "capture",
      jstDayKey(now),
      CAPTURE_DAILY_LIMIT,
    );
    if (!rate.allowed) {
      await tryDm(
        reactor,
        "💡 ナレッジ化の本日の上限(3件)に達しています。明日また試してください。",
        log,
      );
      return;
    }

    // 冪等: 同一メッセージの既存 PR(open/closed 問わず)があれば再作成しない。
    const head = captureBranch(message.id);
    const existing = (await gh.listPullRequests(ops.kb_repo, { state: "all" })).find(
      (p) => p.headRef === head,
    );
    if (existing !== undefined) {
      await tryDm(reactor, `この 💡 は既に PR 化されています: ${existing.url}`, log);
      return;
    }

    const context = await collectContext(message);
    if (context.length === 0) return; // 本文なし(embed のみ等)は対象外

    const triage = await runTriage(
      { context, cwd: deps.cwd },
      { promptStore, ...(deps.triageSearch ? { search: deps.triageSearch } : {}) },
    );
    if (!triage.capture) {
      // 誤検知でノイズ PR を作るより静かに終える(§6.4。DM も送らない)。
      log.info({ reason: triage.reason }, "capture triaged out");
      return;
    }

    const candidate = await runDraft(
      { context, cwd: deps.cwd },
      { promptStore, ...(deps.draftSearch ? { search: deps.draftSearch } : {}) },
    );
    const { id, counterJson } = await allocateCaptureId(gh, ops.kb_repo, now);
    const owner = githubForDiscord(await deps.getMembers(), reactor.id) ?? "unassigned";
    const built = buildCaptureEntry(id, candidate, message.url, owner, now);
    const pr = await gh.createPullRequest({
      repo: ops.kb_repo,
      head,
      title: `docs(kb): 💡 capture — ${candidate.title}`,
      body: [
        "💡 リアクションからナレッジ記事を起こしました(§6.4 ③-a)。",
        "",
        `- 元メッセージ: ${message.url}`,
        `- 起票者: <@${reactor.id}>(👍 は本人の DM から)`,
        "",
        "スキーマ検証はこのリポの validate CI が行います。",
      ].join("\n"),
      files: [
        {
          path: built.path,
          content: serializeEntry({ frontmatter: built.frontmatter, body: built.body }),
        },
        { path: "_meta/id-counter.json", content: counterJson },
      ],
    });
    await tryDm(
      reactor,
      [
        `💡 をナレッジ化する PR を作成しました: ${pr.url}`,
        "内容を確認して、この DM に 👍 を付けるとマージされます。修正したい場合は PR を直接編集してください。",
      ].join("\n"),
      log,
    );
    log.info({ pr: pr.number, id }, "capture PR created");
  } catch (err) {
    if (err instanceof GhClientError && err.code === "CONFLICT") {
      // ブランチ既存(ほぼ同時の 💡)。冪等扱いで静かに終える。
      withCorrelation(deps.logger, "capture").warn({ err }, "capture PR already exists");
      return;
    }
    withCorrelation(deps.logger, "capture").error({ err }, "lightbulb capture failed");
  }
}

/** DM 送信(DM 拒否設定ではエラーになるため握りつぶしてログのみ)。 */
async function tryDm(user: User, content: string, log: Logger): Promise<void> {
  try {
    await user.send(content);
  } catch (err) {
    log.warn({ err }, "DM 送信に失敗(受信拒否設定の可能性)");
  }
}
