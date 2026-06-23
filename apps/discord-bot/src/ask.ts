/**
 * /ask オーケストレータ(design.md §6.2)。純関数寄りに保ち、依存は注入する(テスト容易性)。
 * フロー: RepoSyncer.sync → loadPrompt(qa/answer) → search(agentic) → citation 多層検証 →
 * permalink 化 → queries 記録 → notFound/出典全滅は pending_actions(question_queue)へ。
 *
 * QaCitation は **discord-bot 側の引用ドメイン**で、kb-core の Source(KB エントリの provenance)
 * とは別物(修正2)。kb-core は検証・permalink 変換の道具としてのみ再利用する(format.ts)。
 * commit SHA(resolvedCommit)は LLM を信頼せず bot が付与する(permalink が後からズレないため)。
 */
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { parseLineRange } from "@stratum/kb-core";
import { loadPrompt, type PromptStore, type Usage } from "@stratum/llm";
import { z } from "zod";
import type { AnswerStatus, BotStore } from "./db.js";
import { formatAnswer } from "./format.js";
import type { RepoSpec, RepoSyncer, SyncedRepo } from "./repos.js";

// discord ドメイン検証は kb-core と同一の permalink 規律(§9.5)に揃える。
const DISCORD_PERMALINK_RE = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** lines は kb-core の正典(parseLineRange)で検証する(形式 + start>=1 かつ start<=end)。 */
function isValidLineRange(lines: string): boolean {
  try {
    parseLineRange(lines);
    return true;
  } catch {
    return false;
  }
}

/** LLM が返す生の引用(ref/SHA は信頼しないので持たせない)。 */
export const qaCitationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("github_file"),
      repo: z.string(),
      path: z.string(),
      lines: z.string().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("github_pr"), repo: z.string(), number: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal("github_issue"),
      repo: z.string(),
      number: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("discord"), url: z.string() }).strict(),
]);
export type QaCitation = z.infer<typeof qaCitationSchema>;

/** SDK outputFormat に渡す回答スキーマ(§7.2: 受領後に再 parse 検証)。 */
export const qaAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(qaCitationSchema),
  notFound: z.boolean(),
});
export type QaAnswer = z.infer<typeof qaAnswerSchema>;

/** 検証通過 + bot が ref(commit SHA)を付与した引用。permalink 生成可能。 */
export type ResolvedCitation =
  | { kind: "github_file"; repo: string; path: string; ref: string; lines?: string }
  | { kind: "github_pr"; repo: string; number: number }
  | { kind: "github_issue"; repo: string; number: number }
  | { kind: "discord"; url: string };

/**
 * path が repo root 外へ逃げていない(絶対パス/.. トラバーサル/null バイト拒否)。
 * 注意: clone 内のシンボリックリンクは追従しうるため、これ単体は封じ込め境界ではない。
 * 真の封じ込めは ADR-0006 D1 の OS/コンテナ FS サンドボックス(本番必須)に依存する。
 */
function isSafeRelPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) return false;
  const norm = normalize(path);
  return !norm.startsWith("..") && !norm.startsWith("/");
}

/**
 * モデルが返した citation を多層検証する(修正5。LLM 返却を信頼しない)。
 * 1) zod は呼び出し側(qaAnswerSchema)で済み 2) ドメイン github/discord のみ
 * 3) repo が同期対象 allowlist 内 4) path トラバーサル拒否
 * 5) lines は形式妥当 + ファイル実在 + ref=resolvedCommit 6) 全滅は呼び出し側が notFound に倒す
 */
export function validateCitations(
  citations: readonly QaCitation[],
  synced: readonly SyncedRepo[],
  fileExists: (absPath: string) => boolean = existsSync,
): ResolvedCitation[] {
  const byRepo = new Map(synced.map((s) => [s.repo, s]));
  const out: ResolvedCitation[] = [];
  for (const c of citations) {
    if (c.kind === "discord") {
      if (DISCORD_PERMALINK_RE.test(c.url)) out.push({ kind: "discord", url: c.url });
      continue;
    }
    // github_* は repo が "org/name" 形式かつ同期対象 allowlist 内であること。
    if (!REPO_RE.test(c.repo) || !byRepo.has(c.repo)) continue;
    if (c.kind === "github_pr" || c.kind === "github_issue") {
      out.push({ kind: c.kind, repo: c.repo, number: c.number });
      continue;
    }
    // github_file: path 安全性 / lines 形式 / ファイル実在 / ref=resolvedCommit。
    const syncedRepo = byRepo.get(c.repo);
    if (syncedRepo === undefined || !isSafeRelPath(c.path)) continue;
    if (c.lines !== undefined && !isValidLineRange(c.lines)) continue;
    if (!fileExists(join(syncedRepo.absDir, c.path))) continue;
    out.push({
      kind: "github_file",
      repo: c.repo,
      path: c.path,
      ref: syncedRepo.resolvedCommit,
      ...(c.lines !== undefined ? { lines: c.lines } : {}),
    });
  }
  return out;
}

/** agentic search の最小シグネチャ(注入でモック)。実体は index.ts で runAgentSearch を包む。 */
export interface QaSearchInput {
  systemPrompt: string;
  question: string;
  cwd: string;
}
export type QaSearch = (input: QaSearchInput) => Promise<{ value: QaAnswer; usage: Usage }>;

export interface AskRequest {
  question: string;
  discordUserId: string;
  discordChannelId: string;
  threadId: string | null;
  correlationId: string;
}

export interface AskDeps {
  repos: readonly RepoSpec[];
  syncer: RepoSyncer;
  promptStore: PromptStore;
  store: BotStore;
  /** 検索対象 clone ルート(Agent SDK の cwd)。 */
  clonesDir: string;
  search: QaSearch;
  /** query id 生成(注入)。 */
  newId: () => string;
  /** ISO 8601 タイムスタンプ生成(注入)。 */
  now: () => string;
  /** 単調増加クロック(ms、所要時間計測用。注入。既定 performance.now)。§6.2 step5。 */
  monotonicMs?: () => number;
  /** ファイル実在判定(注入。既定 fs.existsSync)。 */
  fileExists?: (absPath: string) => boolean;
  /** エラー観測フック(§7.4。既定 no-op。PR-4b で相関 ID 付き pino を渡す)。 */
  logError?: (err: unknown) => void;
}

export interface AskResult {
  /** ユーザに返す本文(出典脚注つき / 未回答・エラー文面)。 */
  answerText: string;
  status: AnswerStatus;
  queryId: string;
}

export const NOT_FOUND_MESSAGE =
  "根拠が見つからなかったため、推測での回答は控えます。質問は記録し、詳しい人に確認を依頼します(§6.2 / P6)。";
export const ERROR_MESSAGE =
  "すみません、回答中にエラーが発生しました。時間をおいて再度お試しください。";

/** 既定の単調クロック(§6.2 step5 の所要時間計測)。壁時計でなく monotonic を使う。 */
const defaultMonotonicMs = (): number => performance.now();

/** /ask 1 件を処理し、queries に記録して返す(notFound/全滅は pending_actions へ)。 */
export async function handleAskRequest(req: AskRequest, deps: AskDeps): Promise<AskResult> {
  const queryId = deps.newId();
  const createdAt = deps.now();
  // §6.2 step5: 所要時間を記録する。monotonic で開始時刻を取り、各記録点で差分を ms で出す。
  const monoNow = deps.monotonicMs ?? defaultMonotonicMs;
  const startedAt = monoNow();
  const base = {
    id: queryId,
    correlationId: req.correlationId,
    discordUserId: req.discordUserId,
    discordChannelId: req.discordChannelId,
    threadId: req.threadId,
    question: req.question,
    createdAt,
  };
  try {
    const synced = await deps.syncer.sync(deps.repos);
    const prompt = await loadPrompt("qa", "answer", deps.promptStore);
    const { value, usage } = await deps.search({
      systemPrompt: prompt.body,
      question: req.question,
      cwd: deps.clonesDir,
    });
    const valid = value.notFound
      ? []
      : validateCitations(value.citations, synced, deps.fileExists ?? existsSync);

    // P6 / 出典規律: notFound、または出典が全滅したら捏造せず未回答に倒す(修正5 step6)。
    if (value.notFound || valid.length === 0) {
      deps.store.recordQuery({
        ...base,
        answer: null,
        sourcesJson: null,
        answerStatus: "unanswered",
        feedback: null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        elapsedMs: Math.round(monoNow() - startedAt),
      });
      // git には書かず SQLite キューへ(gap-tracker が Phase 3 で commit)。
      deps.store.queueAction({
        id: deps.newId(),
        type: "question_queue",
        queryId,
        payloadJson: null,
        state: "pending",
        createdAt,
      });
      return { answerText: NOT_FOUND_MESSAGE, status: "unanswered", queryId };
    }

    const answerText = formatAnswer(value.answer, valid);
    deps.store.recordQuery({
      ...base,
      answer: answerText,
      sourcesJson: JSON.stringify(valid),
      answerStatus: "answered",
      feedback: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      elapsedMs: Math.round(monoNow() - startedAt),
    });
    return { answerText, status: "answered", queryId };
  } catch (err) {
    // §6.2 失敗時: エラーを記録(unanswered とは区別=キューに積まない)。観測フックへ通知(§7.4)。
    deps.logError?.(err);
    deps.store.recordQuery({
      ...base,
      answer: null,
      sourcesJson: null,
      answerStatus: "error",
      feedback: null,
      inputTokens: null,
      outputTokens: null,
      elapsedMs: Math.round(monoNow() - startedAt),
    });
    return { answerText: ERROR_MESSAGE, status: "error", queryId };
  }
}
