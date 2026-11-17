/**
 * /ask オーケストレータ(design.md §6.2)。純関数寄りに保ち、依存は注入する(テスト容易性)。
 * フロー: RepoSyncer.sync → loadPrompt(qa/answer) → search(agentic) → citation 多層検証 →
 * permalink 化 → queries 記録 → notFound/出典全滅は pending_actions(question_queue)へ。
 * 同期はリポ単位(ADR-0036 D5・syncForAskPerRepo): sync_on_ask 分だけを同期し(TTL 内は再利用・
 * 失敗時は許容期間内の前回データ・段階 1-2)、それ以外は定期同期の結果(RepoRegistry)を使う。
 *
 * QaCitation は **discord-bot 側の引用ドメイン**で、kb-core の Source(KB エントリの provenance)
 * とは別物(修正2)。kb-core は検証・permalink 変換の道具としてのみ再利用する(format.ts)。
 * commit SHA(resolvedCommit)は LLM を信頼せず bot が付与する(permalink が後からズレないため)。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { parseLineRange, safeParseEntry } from "@stratum/kb-core";
import {
  type AgentInProcessTool,
  type AgentProgressEvent,
  type AgentRunUsage,
  type AgentSearchResult,
  isModelSubstituted,
  LlmError,
  loadPrompt,
  type PromptStore,
} from "@stratum/llm";
import { z } from "zod";
import {
  type AskFailure,
  type AskPipelineMetrics,
  type AskSearchMetrics,
  type AskStage,
  type AskSyncMetrics,
  type AskUsageMetrics,
  classifyAskError,
  createUsageAccumulator,
  searchMetricsOf,
  usageOfResult,
} from "./ask-metrics.js";
import type { AnswerStatus, BotStore } from "./db.js";
import type { DiscordSearchSession } from "./discord-search-tool.js";
import { formatAnswer } from "./format.js";
import type { RepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";
import type { RepoSpec, RepoSyncer, SyncedRepo } from "./repos.js";
import type { SystemOneHook } from "./system-one/index.js";
import { formatJstShort } from "./time.js";

// discord ドメイン検証は kb-core と同一の permalink 規律(§9.5)に揃える。
const DISCORD_PERMALINK_RE = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** manifest に載せるリポ説明の上限文字数(対応表がリポ数に比例して膨らむのを抑える)。 */
export const MANIFEST_DESCRIPTION_MAX_CHARS = 120;

/**
 * リポ説明を manifest の 1 行に収まる形へ整える。改行・連続空白は 1 つの空白に畳んで前後を trim し、
 * 上限を超えたら切り詰めて末尾を「…」にする。空になったら undefined(説明なし扱い)。
 */
export function sanitizeRepoDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const oneLine = description.replace(/\s+/g, " ").trim();
  if (oneLine === "") return undefined;
  const chars = Array.from(oneLine); // サロゲートペアを途中で割らない
  if (chars.length <= MANIFEST_DESCRIPTION_MAX_CHARS) return oneLine;
  return `${chars
    .slice(0, MANIFEST_DESCRIPTION_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

/** manifest の並び順(org/name → subdir の順にコード単位で比較。ロケールに依存させない)。 */
function compareRepoSpec(a: RepoSpec, b: RepoSpec): number {
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
  return 0;
}

/**
 * 検索対象 repo の「subdir ↔ org/name」対応表(manifest)を組む(§6.2)。system prompt の**後半**
 * (プロンプト本文の後・QaSearchInput.systemPromptDynamic)に置く。
 * cwd 配下のサブディレクトリ名しか見えないエージェントに、引用すべき `repo`(org/name)を教える。
 * これが無いと本番 /ask でモデルが正しい repo を引用できない(eval と同一の manifest を共用する)。
 * description があれば行末に ` — 説明` を足し、探索するリポを絞る手がかりにする(ADR-0036 D6)。
 * 行は org/name の順に並べ、入力の順序(列挙・同期の完了順)に依らず同じリポ集合なら同じバイト列にする
 * (プロンプトキャッシュを効かせるため・/ask 高速化)。
 */
export function buildRepoManifest(repos: readonly RepoSpec[]): string {
  if (repos.length === 0) return "";
  const lines = [...repos].sort(compareRepoSpec).map((r) => {
    const base = `- ${r.repo} → サブディレクトリ \`${r.dir}/\``;
    const description = sanitizeRepoDescription(r.description);
    return description === undefined ? base : `${base} — ${description}`;
  });
  return [
    "## 検索対象リポジトリ(このコーパスでの対応)",
    ...lines,
    "引用の repo にはこの org/name を使い、path は各サブディレクトリ配下からの相対パスにすること" +
      "(サブディレクトリ名そのものは path に含めない。例: `<サブディレクトリ>/docs/a.md` を読んだら path は `docs/a.md`)。",
    "",
  ].join("\n");
}

/** lines は kb-core の正典(parseLineRange)で検証する(形式 + start>=1 かつ start<=end)。 */
function isValidLineRange(lines: string): boolean {
  try {
    parseLineRange(lines);
    return true;
  } catch {
    return false;
  }
}

/**
 * モデル出力の lines の表記ゆれを正典形式("L120" / "L120-L141")へ正規化する(修正5 の前段)。
 * 一意に解釈できるものだけ: "26"→"L26"、"26-31"→"L26-L31"、"L26-31"→"L26-L31"、"l26"→"L26"。
 * 解釈できない・正規化しても不正(逆順・0 開始)なものは undefined を返し、呼び出し側が従来
 * どおり citation ごと破棄する(実在検証済みの出典を書式 1 文字で全損させない。VM 実証 2026-07-22:
 * モデルが lines:"26" を返し、唯一の出典が破棄されて /ask が未回答に倒れた)。
 */
export function normalizeLineRange(lines: string): string | undefined {
  const m = /^[Ll]?(\d+)(?:\s*-\s*[Ll]?(\d+))?$/.exec(lines.trim());
  if (m === null) return undefined;
  const [, startRaw, endRaw] = m;
  if (startRaw === undefined) return undefined; // 正規表現上あり得ないが型ガード
  // 先頭ゼロも剥がす("L026" は GitHub の行アンカーとして機能しない)。Number() は巨大数で
  // 指数表記になり得るため BigInt で文字列化する。
  const start = String(BigInt(startRaw));
  const norm = endRaw === undefined ? `L${start}` : `L${start}-L${String(BigInt(endRaw))}`;
  return isValidLineRange(norm) ? norm : undefined;
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

/** 回答ありなのに本文として成り立たない answer の最短字数(退化回答の判定)。 */
export const MIN_ANSWER_CHARS = 20;
/** モデルが形式を試すために入れる仮の値(2026-10-01 に「test」「テスト」で実際に確定した)。 */
const PLACEHOLDER_ANSWER_RE = /^(test|テスト|placeholder|dummy|sample|サンプル)[.。!!]?$/i;
/** StructuredOutput の引数が崩れ、後続の引数が answer の文字列に吸い込まれたときの痕跡。 */
const LEAKED_TOOL_MARKUP_RE = /<\/answer>|<parameter name=|<\/parameter>/;

/**
 * 回答ありなのに本文として成り立たない answer を検出し、理由を返す(問題なければ null)。
 * 2026-10-01: 実モデルが StructuredOutput の引数を 3 回崩した後に仮の値で呼び直し、SDK がそれを最終回答に
 * 採用して「test」がそのまま利用者に返る不具合があった。型は正しいため zod の型検証だけでは通ってしまう。
 */
export function degenerateAnswerReason(answer: string, notFound: boolean): string | null {
  if (notFound) return null;
  const a = answer.trim();
  if (PLACEHOLDER_ANSWER_RE.test(a)) return "placeholder";
  if (LEAKED_TOOL_MARKUP_RE.test(a)) return "leaked_tool_markup";
  if ([...a].length < MIN_ANSWER_CHARS) return "too_short";
  return null;
}

/**
 * SDK outputFormat に渡す回答スキーマ(§7.2: 受領後に再 parse 検証)。
 * superRefine は JSON Schema 化(SDK へ渡す形)には現れず、受領後の safeParse でだけ効く。
 * 退化回答は STRUCTURED_PARSE となり、qa-search の再試行で 1 回だけ検索し直す。
 */
export const qaAnswerSchema = z
  .object({
    answer: z.string(),
    citations: z.array(qaCitationSchema),
    notFound: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const reason = degenerateAnswerReason(v.answer, v.notFound);
    if (reason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: `回答本文が成り立っていません(${reason})`,
      });
    }
  });
export type QaAnswer = z.infer<typeof qaAnswerSchema>;

/** 検証通過 + bot が ref(commit SHA)を付与した引用。permalink 生成可能。 */
export type ResolvedCitation =
  | {
      kind: "github_file";
      repo: string;
      path: string;
      ref: string;
      lines?: string;
      /** 引用先が KB エントリで status:"stale" のとき true(§6.7 の注記付き引用・C8)。 */
      stale?: boolean;
    }
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

/** path の先頭が clone のディレクトリ名(`<dir>/`)なら外した path を返す。付いていなければ null。 */
function stripCloneDirPrefix(path: string, absDir: string): string | null {
  const prefix = `${basename(absDir)}/`;
  const norm = path.startsWith("./") ? path.slice(2) : path;
  if (!norm.startsWith(prefix)) return null;
  const rest = norm.slice(prefix.length);
  return isSafeRelPath(rest) ? rest : null;
}

/** 既定のファイル読み取り(注入可)。読めない場合は null(stale 判定をスキップするだけで壊さない)。 */
const defaultReadFile = (absPath: string): string | null => {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
};

/**
 * 引用先が「stale な KB エントリ」かをコードで決定論的に判定する(§6.7 / C8。LLM に任せない)。
 * どの同期リポが knowledge-base かは設定で持たず、**内容で判定**する: kb-core のスキーマで
 * parse できるファイルだけが KB エントリ(id 接頭辞で kind が排他なので、順に試して最初の成功を採る)。
 * 議事録やコードの .md は frontmatter が無い/スキーマ外なので自然に対象外になる。
 */
export function isStaleKbEntry(raw: string): boolean {
  for (const kind of ["knowledge", "decision", "question"] as const) {
    const r = safeParseEntry(raw, kind);
    if (r.ok) {
      const fm = r.entry.frontmatter as { status?: unknown };
      return fm.status === "stale";
    }
  }
  return false;
}

/**
 * モデルが返した citation を多層検証する(修正5。LLM 返却を信頼しない)。
 * 1) zod は呼び出し側(qaAnswerSchema)で済み 2) ドメイン github/discord のみ
 * 3) repo が同期対象 allowlist 内 4) path トラバーサル拒否
 * 5) lines は形式妥当 + ファイル実在 + ref=resolvedCommit 6) 全滅は呼び出し側が notFound に倒す
 * discord 引用は形式に加え、allowedDiscordPermalinks が渡されたとき(Discord 本文検索が有効な /ask)は
 * **今回 discord_search が返した permalink** に限る(= 質問者に見えるメッセージだけ・ADR-0038 D7)。
 * 未指定(機能 OFF)は従来どおり形式のみ。
 */
export function validateCitations(
  citations: readonly QaCitation[],
  synced: readonly SyncedRepo[],
  fileExists: (absPath: string) => boolean = existsSync,
  readFile: (absPath: string) => string | null = defaultReadFile,
  allowedDiscordPermalinks?: ReadonlySet<string>,
): ResolvedCitation[] {
  const byRepo = new Map(synced.map((s) => [s.repo, s]));
  const out: ResolvedCitation[] = [];
  for (const c of citations) {
    if (c.kind === "discord") {
      if (!DISCORD_PERMALINK_RE.test(c.url)) continue;
      if (allowedDiscordPermalinks !== undefined && !allowedDiscordPermalinks.has(c.url)) continue;
      out.push({ kind: "discord", url: c.url });
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
    // lines は表記ゆれを正規化してから採用する(正規化不能・不正範囲は citation ごと破棄)。
    const lines = c.lines === undefined ? undefined : normalizeLineRange(c.lines);
    if (c.lines !== undefined && lines === undefined) continue;
    // モデルは cwd(clone の親)からの相対で読むため、path の先頭に clone のディレクトリ名(対応表の `<dir>/`)を
    // 付けたまま返すことがある。そのままでは実在せず出典ごと捨てていた(golden eval gq-003・2026-11-17)。
    // 付いていて、外した先が実在するときだけ外して採用する(実在しない path を通すことはない)。
    let relPath = c.path;
    if (!fileExists(join(syncedRepo.absDir, relPath))) {
      const stripped = stripCloneDirPrefix(relPath, syncedRepo.absDir);
      if (stripped === null || !fileExists(join(syncedRepo.absDir, stripped))) continue;
      relPath = stripped;
    }
    const absPath = join(syncedRepo.absDir, relPath);
    // §6.7 / C8: stale な KB エントリの引用は落とさず、注記フラグを付けて通す(除外はしない)。
    const raw = relPath.endsWith(".md") ? readFile(absPath) : null;
    const stale = raw !== null && isStaleKbEntry(raw);
    out.push({
      kind: "github_file",
      repo: c.repo,
      path: relPath,
      ref: syncedRepo.resolvedCommit,
      ...(lines !== undefined ? { lines } : {}),
      ...(stale ? { stale: true } : {}),
    });
  }
  return out;
}

/** agentic search の最小シグネチャ(注入でモック)。実体は index.ts で runAgentSearch を包む。 */
/**
 * /ask の進捗イベント(ADR-0035 D5)。sync(clone 更新)→ search(検索開始)→ tool_use×N。
 * discord 側の進捗表示(progress.ts)が購読する。
 */
export type AskProgressEvent = { kind: "sync" } | { kind: "search" } | AgentProgressEvent;

export interface QaSearchInput {
  /** system prompt の静的な前半(qa/answer の本文)。 */
  systemPrompt: string;
  /**
   * system prompt の後半に置く、/ask ごとに変わりうる部分(repo 対応表)。runAgentSearch の
   * systemPromptDynamic へ透過し、静的な前半をプロンプトキャッシュに残す(/ask 高速化)。
   */
  systemPromptDynamic?: string;
  question: string;
  cwd: string;
  /** 進捗の購読(ADR-0035 D5)。runAgentSearch へ透過する。 */
  onProgress?: (ev: AgentProgressEvent) => void;
  /** 正常終了時の中断(ADR-0035 追記)。runAgentSearch へ透過する。 */
  signal?: AbortSignal;
  /**
   * 検索の試行ごとに 1 回呼ぶ(再試行を含む・段階 1-1)。usage はその回の使用量(result が無ければ null)。
   * 完了ログの費用・トークンを全試行の合計にするために使う。
   */
  onAttempt?: (usage: AgentRunUsage | null) => void;
  /** プロセス内ツール(ADR-0038 D6。Discord 本文検索が有効な /ask の discord_search)。 */
  inProcessTools?: readonly AgentInProcessTool[];
  /** ユーザープロンプトの前置き(System One の候補ブロック・ADR-0041 D5)。未指定なら質問文だけ。 */
  promptPrefix?: string;
}
/** 戻りは runAgentSearch と同形(numTurns / durationApiMs を型で落とさない・ADR-0035 D4)。 */
export type QaSearch = (input: QaSearchInput) => Promise<AgentSearchResult<QaAnswer>>;

export interface AskRequest {
  question: string;
  discordUserId: string;
  discordChannelId: string;
  threadId: string | null;
  correlationId: string;
}

/** /ask の同期の TTL 再利用の既定(段階 1-2)。env ASK_SYNC_TTL_MS で上書き(index.ts)。 */
export const DEFAULT_ASK_SYNC_TTL_MS = 60_000;
/**
 * 同期に失敗したリポを前回データで検索してよい期間の既定(段階 1-2・6 時間)。
 * env ASK_SYNC_MAX_STALENESS_MS で上書き(index.ts)。
 */
export const DEFAULT_ASK_SYNC_MAX_STALENESS_MS = 6 * 60 * 60 * 1000;

/**
 * リポ単位の同期(ADR-0036 D5・段階 1-2)。index.ts は常に注入する(手動指定だけの構成も含む)。
 * - registry: 検索範囲・最新の SyncedRepo・最終成功同期の時刻(/ask と定期同期が更新する)。
 * - ttlMs: 最終成功同期からこの時間内なら fetch せず再利用する(作業ツリーがクリーンで HEAD が記録 SHA と
 *   一致する場合だけ)。
 * - maxStalenessMs: 同期に失敗しても、最終成功同期からこの時間内なら前回データで検索する(脚注で明示)。
 */
export interface PerRepoSyncDeps {
  registry: RepoRegistry;
  ttlMs?: number;
  maxStalenessMs?: number;
  /** 壁時計 ms(注入・既定 Date.now)。TTL・許容期間・脚注の時刻に使う。 */
  nowMs?: () => number;
}

/** 前回データで検索したリポ(脚注の時刻に使う)。 */
export interface StaleRepo {
  repo: string;
  /** 最終成功同期の時刻(壁時計 ms)。 */
  fetchedAtMs: number;
}

/**
 * 同期に失敗し、許容期間内の前回データも無い(初回同期の失敗・許容期間超え)ため /ask を続けられない
 * (段階 1-2)。利用者には専用の文面(syncFailedMessage)を返す。cause は最初の失敗(git の失敗等)。
 */
export class AskSyncError extends Error {
  override readonly name = "AskSyncError";
  readonly repos: readonly string[];
  constructor(repos: readonly string[], cause: unknown) {
    super(`リポの同期に失敗し、利用できる前回データもありません: ${repos.join(", ")}`, { cause });
    this.repos = repos;
  }
}

export interface AskDeps {
  /** 検索範囲(/ask のたびに読む getter。all_visible 有効時は定期同期で差し替わる・ADR-0036)。 */
  getRepos: () => readonly ScopedRepo[];
  syncer: RepoSyncer;
  /**
   * 指定時はリポ単位の同期(ADR-0036 D5・段階 1-2 の TTL 再利用と前回データ利用)。index.ts は常に指定する。
   * 未指定 = 全リポを /ask ごとに同期し、1 リポでも失敗したら /ask 全体をエラーにする(テスト等の簡易構成)。
   */
  perRepo?: PerRepoSyncDeps;
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
  /** 引用先ファイルの読み取り(stale KB 判定用。注入。既定 fs.readFileSync。失敗は null)。 */
  readFile?: (absPath: string) => string | null;
  // 情報ログのフックは持たない: 所要時間・ターン数・トークン・同期の件数(ADR-0035 D4)は
  // AskResult.metrics で返し、discord.ts が配送後に 1 行の完了ログで出す(段階 1-1)。
  /** エラー観測フック(§7.4。既定 no-op。PR-4b で相関 ID 付き pino を渡す)。 */
  logError?: (err: unknown) => void;
  /** 警告観測フック(§7.4。既定 no-op。「回答はあるのに全 citation が検証で破棄」等の診断用)。 */
  logWarn?: (data: Record<string, unknown>, msg: string) => void;
  /** 進捗の購読(ADR-0035 D5。既定 no-op)。 */
  onProgress?: (ev: AskProgressEvent) => void;
  /** 実効の検索タイムアウト(ms)。タイムアウト文面の秒数表示に使う(既定 DEFAULT_ASK_TIMEOUT_MS)。 */
  searchTimeoutMs?: number;
  /**
   * bot の正常終了による中断(ADR-0035 追記)。abort されたら同期後・検索中のどこでも打ち切り、
   * `interrupted` として記録して INTERRUPTED_MESSAGE を返す。
   */
  signal?: AbortSignal;
  /**
   * Discord 本文検索(ADR-0038)。機能が有効な /ask では質問者ごとに作って渡す(検索範囲が空ならツールは 0 本)。
   * 渡したときは discord 引用を「今回ツールが返した permalink」に限る(D7)。未指定 = 機能 OFF(従来どおり)。
   */
  discordSearch?: DiscordSearchSession;
  /** System One 判定層(ADR-0041。env ASK_FASTPATH が off なら未指定 = 従来どおり)。 */
  systemOne?: SystemOneHook;
}

export interface AskResult {
  /** ユーザに返す本文(出典脚注つき / 未回答・エラー文面)。 */
  answerText: string;
  status: AnswerStatus;
  queryId: string;
  /** 工程別の計測値(段階 1-1。discord.ts が完了ログに載せる。stub 等では省略可)。 */
  metrics?: AskPipelineMetrics;
}

export const NOT_FOUND_MESSAGE =
  "根拠が見つからなかったため、推測での回答は控えます。質問は記録し、詳しい人に確認を依頼します(§6.2 / P6)。";
export const ERROR_MESSAGE =
  "すみません、回答中にエラーが発生しました。時間をおいて再度お試しください。";

/** 受付からの期限を過ぎてから順番が来たとき(検索しない・ADR-0035 追記 D2')。 */
export const DEADLINE_SKIPPED_MESSAGE =
  "混雑のため時間内に回答できませんでした。お手数ですがもう一度質問してください。";
/** bot の再起動で中断したとき(正常終了・強制終了後の後始末とも同じ文面・ADR-0035 追記)。 */
export const INTERRUPTED_MESSAGE =
  "再起動のため中断しました。お手数ですがもう一度質問してください。";

/** 検索せずに終える /ask の状態(ADR-0035 追記)。 */
export type SkippedAskStatus = Extract<AnswerStatus, "timeout_skipped" | "interrupted">;

/**
 * 検索を行わずに終える /ask を記録して、利用者向けの結果を返す(ADR-0035 追記)。
 * - timeout_skipped: 受付からの期限を過ぎてから順番が来た(混雑)。
 * - interrupted: 再起動で順番待ちのまま終えた / 検索を中断した。
 * どちらもナレッジの欠落ではないので question_queue には積まない。記録の失敗は結果を変えない
 * (利用者への通知を優先する)。
 */
export function recordSkippedAsk(
  req: AskRequest,
  deps: Pick<AskDeps, "store" | "newId" | "now" | "logError">,
  status: SkippedAskStatus,
  elapsedMs: number | null = null,
): AskResult {
  const queryId = deps.newId();
  try {
    deps.store.recordQuery({
      id: queryId,
      correlationId: req.correlationId,
      discordUserId: req.discordUserId,
      discordChannelId: req.discordChannelId,
      threadId: req.threadId,
      question: req.question,
      createdAt: deps.now(),
      answer: null,
      sourcesJson: null,
      answerStatus: status,
      feedback: null,
      inputTokens: null,
      outputTokens: null,
      elapsedMs,
    });
  } catch (err) {
    deps.logError?.(err);
  }
  return {
    answerText: status === "interrupted" ? INTERRUPTED_MESSAGE : DEADLINE_SKIPPED_MESSAGE,
    status,
    queryId,
  };
}

/**
 * 同期に失敗し、利用できる前回データも無いときの文面(段階 1-2)。汎用の ERROR_MESSAGE と区別し、
 * 原因(ナレッジの最新化の失敗)と対象リポを伝える。
 */
export function syncFailedMessage(repos: readonly string[]): string {
  return (
    `すみません、ナレッジの最新化(${repos.join("、")})に失敗し、利用できる直近のデータも無いため回答できませんでした。` +
    "GitHub との通信に問題がある可能性があります。少し時間をおいて再度お試しください。"
  );
}

/** 前回データで検索したときに回答の末尾へ付ける注記(最も古いリポの同期時刻・JST)。 */
export function staleKnowledgeNote(stale: readonly StaleRepo[]): string | null {
  if (stale.length === 0) return null;
  const oldest = Math.min(...stale.map((r) => r.fetchedAtMs));
  return `※ ナレッジは ${formatJstShort(new Date(oldest))} 時点の内容です(最新化に失敗)`;
}

/** §6.2 失敗時挙動の「上限 600 秒」の正典値(ADR-0035 D1)。env ASK_TIMEOUT_MS による上書きは index.ts。 */
export const DEFAULT_ASK_TIMEOUT_MS = 600_000;

/**
 * タイムアウト時のユーザー向け文面(§6.2 失敗時挙動 / ADR-0030 D3)。所要時間は検索対象サイズに
 * 比例するため「質問を絞る」ことを案内する。/ask は TIMEOUT 非リトライ設計(qa-search.ts)なので
 * 「自動的に再試行します」とは書かない。
 */
export function timeoutMessage(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  return (
    `すみません、検索がタイムアウトしました(制限時間 ${seconds} 秒)。` +
    "質問の対象や期間を絞ると時間内に回答しやすくなります。少し時間をおいて再度お試しください。"
  );
}

/** syncForAskPerRepo の結果。 */
export interface PerRepoSyncOutcome {
  /** clone のあるリポ(manifest 用)。 */
  available: ScopedRepo[];
  /** available と同順の SyncedRepo(引用検証用。ref は検索する作業ツリーの SHA)。 */
  synced: SyncedRepo[];
  /** 前回データで検索するリポ(脚注用)。 */
  stale: StaleRepo[];
  /** 完了ログ用の件数。 */
  metrics: AskSyncMetrics;
}

/**
 * /ask 用のリポ単位同期(ADR-0036 D5・段階 1-2)。SerialQueue のタスク内で呼ぶ(同期・検索・鮮度確認の
 * 書き込みは同じキューで直列化されている)。
 * - sync_on_ask のリポ:
 *   1. TTL 再利用: 最終成功同期が ttlMs 以内・無効化されていない・作業ツリーがクリーン・HEAD が記録 SHA と
 *      一致(`status --porcelain` と `rev-parse` だけで確認)なら fetch しない。
 *   2. それ以外はリポ単位で同期する(syncEach・リポごとに並列。1. の確認・3. の前回データ確認も並列)。
 *   3. 同期に失敗したら、最終成功同期が maxStalenessMs 以内なら前回データで検索する。作業ツリーが汚れて
 *      いれば HEAD に戻してから使い、引用の ref は実 HEAD にする(脚注で時点を明示)。
 *      最終成功時刻はプロセス内の記録を優先し、無ければ(再起動直後)clone の `.git/FETCH_HEAD` の
 *      更新時刻から補う(RepoSyncer.fetchTimeOnDisk)。
 *   4. 許容期間超え・未同期(初回同期の失敗)・クリーンに戻せない clone の扱いはリポの由来で分ける:
 *      - 手動指定(repos.yaml の `repos:`・managed=false。KB・議事録を含む)は AskSyncError
 *        (専用の文面で /ask をエラーにする)。KB も同じ規則(従来の「KB の失敗は常にエラー」から緩めた)。
 *      - 列挙由来(all_visible・managed=true)は今回の対象から外す(manifest・引用の許可リストに載せない)。
 *        /ask 全体は止めない(warn と完了ログの reposExcluded で観測する)。
 * - 今回同期しないリポ(sync_on_ask 外)は定期同期の SyncedRepo → 無ければ `rev-parse HEAD` で解決する。
 *   引用の許可リストは「clone のある全対象リポ」から作る(今回同期分だけにするとコードのリポへの
 *   引用がすべて破棄される)。
 */
export async function syncForAskPerRepo(
  deps: Pick<AskDeps, "getRepos" | "syncer" | "logWarn">,
  perRepo: PerRepoSyncDeps,
): Promise<PerRepoSyncOutcome> {
  const { registry } = perRepo;
  const nowMs = perRepo.nowMs ?? Date.now;
  const ttlMs = perRepo.ttlMs ?? DEFAULT_ASK_SYNC_TTL_MS;
  const maxStalenessMs = perRepo.maxStalenessMs ?? DEFAULT_ASK_SYNC_MAX_STALENESS_MS;
  const scope = deps.getRepos();
  /** sync_on_ask のリポのうち、今回使う SyncedRepo(再利用・同期・前回データ)。 */
  const usable = new Map<string, SyncedRepo>();

  // 1. TTL 再利用(確認の失敗は「再利用しない」に倒す)。
  const reusable = async (spec: ScopedRepo): Promise<SyncedRepo | undefined> => {
    const rec = registry.lastSynced(spec.repo);
    const at = registry.lastFetchedAt(spec.repo);
    if (rec === undefined || at === undefined || registry.isInvalidated(spec.repo))
      return undefined;
    if (nowMs() - at >= ttlMs) return undefined;
    try {
      const st = await deps.syncer.inspect(spec);
      return st?.clean === true && st.synced.resolvedCommit === rec.resolvedCommit
        ? rec
        : undefined;
    } catch {
      return undefined;
    }
  };
  const toSync: ScopedRepo[] = [];
  let reused = 0;
  // リポごとに別の clone なので確認は並列に行う(ADR-0035 追記 2026-10-08)。判定の順序は scope の順。
  const onAsk = scope.filter((r) => r.syncOnAsk);
  const reuse = await Promise.all(onAsk.map((spec) => reusable(spec)));
  onAsk.forEach((spec, i) => {
    const rec = reuse[i];
    if (rec === undefined) {
      toSync.push(spec);
    } else {
      usable.set(spec.repo, rec);
      reused += 1;
    }
  });

  // 3. 前回データ(許容期間内・クリーンな作業ツリー)。使えなければ理由を返す。
  const lastSuccessAt = async (spec: ScopedRepo): Promise<number | undefined> => {
    const recorded = registry.lastFetchedAt(spec.repo);
    if (recorded !== undefined) return recorded;
    // 再起動直後(プロセス内の記録が無い): clone の最終 fetch 時刻から補う。
    try {
      return (await deps.syncer.fetchTimeOnDisk(spec)) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const staleFallback = async (
    spec: ScopedRepo,
  ): Promise<
    | { ok: true; stale: StaleRepo; s: SyncedRepo }
    | { ok: false; reason: "never_synced" | "too_stale" | "no_clean_clone" }
  > => {
    const at = await lastSuccessAt(spec);
    if (at === undefined) return { ok: false, reason: "never_synced" };
    if (nowMs() - at > maxStalenessMs) return { ok: false, reason: "too_stale" };
    try {
      let st = await deps.syncer.inspect(spec);
      // 鮮度確認の書き込み・同期途中の失敗で汚れた作業ツリーは HEAD に戻す(内容と引用 SHA を一致させる)。
      if (st !== null && !st.clean) st = await deps.syncer.restoreHead(spec);
      if (st === null || !st.clean) return { ok: false, reason: "no_clean_clone" };
      return { ok: true, stale: { repo: spec.repo, fetchedAtMs: at }, s: st.synced };
    } catch {
      return { ok: false, reason: "no_clean_clone" };
    }
  };

  // 2. 同期(syncEach がリポごとに並列で行う)。
  const results = await deps.syncer.syncEach(toSync);
  const syncedAt = nowMs();
  const stale: StaleRepo[] = [];
  const unavailable: { repo: string; error: unknown }[] = [];
  let fetched = 0;
  let skippedReset = 0;
  let excluded = 0;
  // 失敗したリポの前回データ確認もリポごとに並列で行う(記録・ログは results の順)。
  const fallbacks = await Promise.all(
    results.map((r) => (r.status === "failed" ? staleFallback(r.spec as ScopedRepo) : null)),
  );
  for (const [i, r] of results.entries()) {
    if (r.status === "synced") {
      registry.recordFetched(r.synced, syncedAt);
      usable.set(r.spec.repo, r.synced);
      fetched += 1;
      if (r.resetSkipped === true) skippedReset += 1;
      continue;
    }
    if (r.status === "empty") {
      // commit の無い空リポ: 失敗ではない(warn しない)。manifest・allowlist から外すだけ。
      registry.recordEmpty(r.spec.repo);
      continue;
    }
    registry.recordError(r.spec.repo, r.error);
    const spec = r.spec as ScopedRepo;
    const fb = fallbacks[i];
    if (fb === null || fb === undefined) continue; // results は failed なので到達しない(型の絞り込み用)
    if (!fb.ok) {
      if (spec.managed) {
        // 列挙由来のリポ 1 件の失敗で /ask 全体を止めない。今回の対象から外す(usable に入れない)。
        excluded += 1;
        deps.logWarn?.(
          { repo: spec.repo, reason: fb.reason, err: r.error },
          "/ask: 列挙由来のリポの同期に失敗し、前回データも使えないため今回の検索対象から外します(段階 1-2)",
        );
        continue;
      }
      unavailable.push({ repo: spec.repo, error: r.error });
      deps.logWarn?.(
        { repo: spec.repo, reason: fb.reason, err: r.error },
        "/ask: リポの同期に失敗し、許容期間内の前回データもありません(/ask はエラー・段階 1-2)",
      );
      continue;
    }
    usable.set(spec.repo, fb.s);
    stale.push(fb.stale);
    deps.logWarn?.(
      { repo: spec.repo, err: r.error, staleAgeMs: syncedAt - fb.stale.fetchedAtMs },
      "/ask: リポの同期に失敗しました(前回データで検索します・段階 1-2)",
    );
  }
  // 4. 使えないリポがあれば検索しない(古さが分からないデータで答えない)。
  const firstUnavailable = unavailable[0];
  if (firstUnavailable !== undefined) {
    throw new AskSyncError(
      unavailable.map((u) => u.repo),
      firstUnavailable.error,
    );
  }

  const head = async (spec: ScopedRepo): Promise<SyncedRepo | undefined> => {
    try {
      return (await deps.syncer.resolveHead(spec)) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const available: ScopedRepo[] = [];
  const synced: SyncedRepo[] = [];
  // 記録の無い sync_on_ask 外のリポは HEAD を並列に解決する(結果の順序は scope の順)。
  const heads = await Promise.all(
    scope.map((spec) =>
      !registry.isEmpty(spec.repo) &&
      !spec.syncOnAsk &&
      usable.get(spec.repo) === undefined &&
      registry.lastSynced(spec.repo) === undefined
        ? head(spec)
        : undefined,
    ),
  );
  scope.forEach((spec, i) => {
    if (registry.isEmpty(spec.repo)) return; // 空リポ(引用できるファイルが無い)
    let s = usable.get(spec.repo);
    if (s === undefined && !spec.syncOnAsk) {
      s = registry.lastSynced(spec.repo);
      if (s === undefined) {
        s = heads[i];
        if (s !== undefined) registry.recordSynced(s);
      }
    }
    if (s === undefined) return; // clone 未取得(初回 clone 待ち)・壊れた clone は対象外
    available.push(spec);
    synced.push(s);
  });
  return {
    available,
    synced,
    stale,
    metrics: {
      reposInScope: scope.length,
      reposAvailable: available.length,
      reposFetched: fetched,
      reposReused: reused,
      reposSkippedReset: skippedReset,
      reposStale: stale.length,
      reposExcluded: excluded,
      staleAgeMs:
        stale.length === 0 ? null : syncedAt - Math.min(...stale.map((x) => x.fetchedAtMs)),
    },
  };
}

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
  // 段階 1-1: 工程別の時間(ms)。到達しなかった工程は null のまま。完了ログは discord.ts が
  // キュー待ち・配送と合わせて 1 行で出す(ask-metrics.ts)。
  const timings: Pick<AskPipelineMetrics, "syncMs" | "promptMs" | "searchMs" | "validateMs"> = {
    syncMs: null,
    promptMs: null,
    searchMs: null,
    validateMs: null,
  };
  let stage: AskStage = "sync";
  let stageStartedAt = startedAt;
  /** 今の工程を締めて次の工程へ進む(締めた工程の ms を返す)。 */
  const endStage = (): number => {
    const t = monoNow();
    const ms = Math.round(t - stageStartedAt);
    stageStartedAt = t;
    return ms;
  };
  let search: AskSearchMetrics | null = null;
  // 段階 1-1: 検索の使用量は全試行(再試行・最終的に失敗した回を含む)の合計を出す。
  const usageAcc = createUsageAccumulator();
  let usageMetrics: AskUsageMetrics | null = null;
  let syncMetrics: AskSyncMetrics | null = null;
  const metricsOf = (elapsedMs: number, failure: AskFailure | null): AskPipelineMetrics => ({
    ...timings,
    elapsedMs,
    sync: syncMetrics,
    search,
    usage: usageMetrics ?? usageAcc.total(),
    // ADR-0038: Discord 本文検索の呼び出し回数と返した件数(本文は出さない)。機能 OFF なら null。
    discordSearch: deps.discordSearch?.stats() ?? null,
    failure,
  });
  // 関数にするのは、await をまたいだ再判定を TS の型の絞り込みに潰されないようにするため。
  const isAborted = (): boolean => deps.signal?.aborted === true;
  // ADR-0035 追記: 正常終了で中断された /ask は interrupted として記録する(キューには積まない)。
  const interrupted = (): AskResult => {
    deps.store.recordQuery({
      ...base,
      answer: null,
      sourcesJson: null,
      answerStatus: "interrupted",
      feedback: null,
      inputTokens: null,
      outputTokens: null,
      elapsedMs: Math.round(monoNow() - startedAt),
    });
    const elapsedMs = Math.round(monoNow() - startedAt);
    // 段階 1-1: 中断も完了ログ(discord.ts)に失敗工程つきで残す。
    return {
      answerText: INTERRUPTED_MESSAGE,
      status: "interrupted",
      queryId,
      metrics: metricsOf(elapsedMs, {
        stage,
        atMs: elapsedMs,
        errorKind: "Aborted",
        errorCode: "ABORTED",
      }),
    };
  };
  /** 前回データで検索したときの注記を末尾に付ける。 */
  const withNote = (text: string, note: string | null): string =>
    note === null ? text : `${text}\n\n${note}`;
  try {
    if (isAborted()) return interrupted();
    deps.onProgress?.({ kind: "sync" });
    let repos: readonly RepoSpec[];
    let synced: SyncedRepo[];
    let staleNote: string | null = null;
    if (deps.perRepo !== undefined) {
      const out = await syncForAskPerRepo(deps, deps.perRepo);
      repos = out.available;
      synced = out.synced;
      syncMetrics = out.metrics;
      // 段階 1-2: 前回データで検索したら、回答の末尾に時点を明示する。
      staleNote = staleKnowledgeNote(out.stale);
    } else {
      // 従来挙動(all_visible 無し): 全リポを同期し、1 リポでも失敗したら /ask 全体をエラーにする。
      repos = deps.getRepos();
      synced = await deps.syncer.sync(repos);
    }
    timings.syncMs = endStage();

    stage = "prompt";
    const prompt = await loadPrompt("qa", "answer", deps.promptStore);
    // §6.2: repo 対応表を渡し、モデルが正しい org/name で引用できるようにする(PR-6a)。
    // all_visible 有効時は clone のあるリポだけを載せる(ADR-0036)。対応表は利用者の閲覧範囲・
    // clone の有無で変わるため、静的な本文の**後**に置く(本文をプロンプトキャッシュに残す・/ask 高速化)。
    const manifest = buildRepoManifest(repos);
    // ADR-0041: 候補ブロック(System One)。throw しない・前置きしないときは null。
    const promptPrefix =
      (await deps.systemOne?.prepare({
        queryId,
        question: req.question,
        synced,
        cwd: deps.clonesDir,
        // ADR-0041 D9: 質問者の閲覧範囲で絞った Discord を事前候補に入れる(ツールの往復を足さない)。
        ...(deps.discordSearch !== undefined ? { discord: deps.discordSearch.candidates } : {}),
      })) ?? null;
    // git sync は中断できない(1 コマンド 60 秒の上限つき)ため、同期後に一度確かめてから検索に入る。
    if (isAborted()) return interrupted();
    timings.promptMs = endStage();

    stage = "search";
    deps.onProgress?.({ kind: "search" });
    // ADR-0038 D6: Discord 本文検索が有効なら、質問者の範囲に閉じた discord_search を渡す。
    const discordTools = deps.discordSearch?.tools ?? [];
    const result = await deps.search({
      systemPrompt: prompt.body,
      ...(manifest !== "" ? { systemPromptDynamic: manifest } : {}),
      question: req.question,
      cwd: deps.clonesDir,
      ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      onAttempt: (u) => usageAcc.add(u),
      ...(discordTools.length > 0 ? { inProcessTools: discordTools } : {}),
      ...(promptPrefix !== null ? { promptPrefix } : {}),
    });
    timings.searchMs = endStage();
    const { value, usage, requestedModel, actualModel } = result;
    // 組織の制限などで指定モデルが無通知で別モデルに置き換わっていないか(2026-10-01 の不具合の直接原因)。
    if (isModelSubstituted(requestedModel, actualModel)) {
      deps.logWarn?.(
        { requestedModel, actualModel },
        "/ask: 指定と異なるモデルが応答しました(組織のモデル制限による置き換えの可能性)",
      );
    }

    stage = "validate";
    const valid = value.notFound
      ? []
      : validateCitations(
          value.citations,
          synced,
          deps.fileExists ?? existsSync,
          deps.readFile ?? defaultReadFile,
          deps.discordSearch?.returnedPermalinks,
        );
    deps.systemOne?.recordCited(queryId, valid); // ADR-0041 D6: 候補が引用されたかの計測
    // ADR-0035 D4 / 段階 1-1: ターン数・トークン等は完了ログ(discord.ts)に載せる。
    search = searchMetricsOf(result, valid.length);
    // 試行ごとの通知が無い検索(テスト用の差し替え等)は最終結果の値を使う。
    usageMetrics = usageAcc.total() ?? usageOfResult(result);

    // 観測性(§7.4): モデルは回答+出典を返したのに検証で全滅したケースは、書式・allowlist 等の
    // 系統的問題のシグナルなので必ず痕跡を残す(2026-07-22 の lines 書式ゆれ調査で必要になった)。
    if (!value.notFound && value.citations.length > 0 && valid.length === 0) {
      deps.logWarn?.(
        { citations: value.citations },
        "/ask: 回答は生成されたが全 citation が検証で破棄されました",
      );
    }
    // P6 / 出典規律: notFound、または出典が全滅したら捏造せず未回答に倒す(修正5 step6)。
    if (value.notFound || valid.length === 0) {
      const elapsedMs = Math.round(monoNow() - startedAt);
      deps.store.recordQuery({
        ...base,
        answer: null,
        sourcesJson: null,
        answerStatus: "unanswered",
        feedback: null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        elapsedMs,
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
      timings.validateMs = endStage();
      return {
        answerText: withNote(NOT_FOUND_MESSAGE, staleNote),
        status: "unanswered",
        queryId,
        metrics: metricsOf(elapsedMs, null),
      };
    }

    const answerText = withNote(formatAnswer(value.answer, valid), staleNote);
    const elapsedMs = Math.round(monoNow() - startedAt);
    deps.store.recordQuery({
      ...base,
      answer: answerText,
      sourcesJson: JSON.stringify(valid),
      answerStatus: "answered",
      feedback: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      elapsedMs,
    });
    timings.validateMs = endStage();
    return { answerText, status: "answered", queryId, metrics: metricsOf(elapsedMs, null) };
  } catch (err) {
    // §6.2 失敗時: エラーを記録(unanswered とは区別=キューに積まない)。観測フックへ通知(§7.4)。
    // タイムアウトは文面と answerStatus で明示する(§6.2 失敗時挙動 / ADR-0030 D3)。ナレッジ欠落
    // ではないので error 同様キューには積まない。code 直判定にするのは、isTransient だと withRetry
    // 済みの 429/529 まで拾ってしまい ERROR_MESSAGE(時間をおいて再度)のままが適切なため。
    // 中断(ABORTED)や、中断と同時に起きた失敗はエラーではなく interrupted として扱う。
    if ((err instanceof LlmError && err.code === "ABORTED") || isAborted()) {
      return interrupted();
    }
    const elapsedMs = Math.round(monoNow() - startedAt);
    const failure: AskFailure = { stage, atMs: elapsedMs, ...classifyAskError(err) };
    const timedOut = err instanceof LlmError && err.code === "TIMEOUT";
    deps.logError?.(err);
    deps.store.recordQuery({
      ...base,
      answer: null,
      sourcesJson: null,
      answerStatus: timedOut ? "timeout" : "error",
      feedback: null,
      inputTokens: null,
      outputTokens: null,
      elapsedMs,
    });
    return {
      answerText: timedOut
        ? timeoutMessage(deps.searchTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS)
        : err instanceof AskSyncError
          ? syncFailedMessage(err.repos)
          : ERROR_MESSAGE,
      status: timedOut ? "timeout" : "error",
      queryId,
      metrics: metricsOf(elapsedMs, failure),
    };
  }
}
