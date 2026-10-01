/**
 * /ask オーケストレータ(design.md §6.2)。純関数寄りに保ち、依存は注入する(テスト容易性)。
 * フロー: RepoSyncer.sync → loadPrompt(qa/answer) → search(agentic) → citation 多層検証 →
 * permalink 化 → queries 記録 → notFound/出典全滅は pending_actions(question_queue)へ。
 * all_visible 有効時(ADR-0036 D5)は sync_on_ask 分だけをリポ単位で同期し、それ以外は
 * 定期同期の結果(RepoRegistry)を使う(syncForAskPerRepo)。
 *
 * QaCitation は **discord-bot 側の引用ドメイン**で、kb-core の Source(KB エントリの provenance)
 * とは別物(修正2)。kb-core は検証・permalink 変換の道具としてのみ再利用する(format.ts)。
 * commit SHA(resolvedCommit)は LLM を信頼せず bot が付与する(permalink が後からズレないため)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { parseLineRange, safeParseEntry } from "@stratum/kb-core";
import {
  type AgentProgressEvent,
  type AgentSearchResult,
  isModelSubstituted,
  LlmError,
  loadPrompt,
  type PromptStore,
} from "@stratum/llm";
import { z } from "zod";
import type { AnswerStatus, BotStore } from "./db.js";
import { formatAnswer } from "./format.js";
import type { RepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";
import type { RepoSpec, RepoSyncer, SyncedRepo } from "./repos.js";

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

/**
 * 検索対象 repo の「subdir ↔ org/name」対応表を systemPrompt に前置する manifest を組む(§6.2)。
 * cwd 配下のサブディレクトリ名しか見えないエージェントに、引用すべき `repo`(org/name)を教える。
 * これが無いと本番 /ask でモデルが正しい repo を引用できない(eval と同一の manifest を共用する)。
 * description があれば行末に ` — 説明` を足し、探索するリポを絞る手がかりにする(ADR-0036 D6)。
 * description が無いリポの行は従来と同一(eval の manifest・ベースラインを変えない)。
 */
export function buildRepoManifest(repos: readonly RepoSpec[]): string {
  if (repos.length === 0) return "";
  const lines = repos.map((r) => {
    const base = `- ${r.repo} → サブディレクトリ \`${r.dir}/\``;
    const description = sanitizeRepoDescription(r.description);
    return description === undefined ? base : `${base} — ${description}`;
  });
  return [
    "## 検索対象リポジトリ(このコーパスでの対応)",
    ...lines,
    "引用の repo にはこの org/name を使い、path は各サブディレクトリ配下からの相対パスにすること。",
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
 */
export function validateCitations(
  citations: readonly QaCitation[],
  synced: readonly SyncedRepo[],
  fileExists: (absPath: string) => boolean = existsSync,
  readFile: (absPath: string) => string | null = defaultReadFile,
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
    // lines は表記ゆれを正規化してから採用する(正規化不能・不正範囲は citation ごと破棄)。
    const lines = c.lines === undefined ? undefined : normalizeLineRange(c.lines);
    if (c.lines !== undefined && lines === undefined) continue;
    const absPath = join(syncedRepo.absDir, c.path);
    if (!fileExists(absPath)) continue;
    // §6.7 / C8: stale な KB エントリの引用は落とさず、注記フラグを付けて通す(除外はしない)。
    const raw = c.path.endsWith(".md") ? readFile(absPath) : null;
    const stale = raw !== null && isStaleKbEntry(raw);
    out.push({
      kind: "github_file",
      repo: c.repo,
      path: c.path,
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
  systemPrompt: string;
  question: string;
  cwd: string;
  /** 進捗の購読(ADR-0035 D5)。runAgentSearch へ透過する。 */
  onProgress?: (ev: AgentProgressEvent) => void;
  /** 正常終了時の中断(ADR-0035 追記)。runAgentSearch へ透過する。 */
  signal?: AbortSignal;
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

/**
 * リポ単位の同期(ADR-0036 D5)。all_visible 有効時だけ注入する。
 * - registry: 検索範囲と最新の SyncedRepo(定期同期が更新する)。
 * - kbDir: KB の clone 先 dir。KB の同期失敗だけは従来どおり /ask 全体のエラーにする。
 */
export interface PerRepoSyncDeps {
  registry: RepoRegistry;
  kbDir: string;
}

export interface AskDeps {
  /** 検索範囲(/ask のたびに読む getter。all_visible 有効時は定期同期で差し替わる・ADR-0036)。 */
  getRepos: () => readonly ScopedRepo[];
  syncer: RepoSyncer;
  /**
   * 指定時はリポ単位の同期(ADR-0036 D5)。未指定 = 従来どおり全リポを /ask ごとに同期し、
   * 1 リポでも失敗したら /ask 全体をエラーにする(all_visible が null の構成)。
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
  /** エラー観測フック(§7.4。既定 no-op。PR-4b で相関 ID 付き pino を渡す)。 */
  logError?: (err: unknown) => void;
  /** 警告観測フック(§7.4。既定 no-op。「回答はあるのに全 citation が検証で破棄」等の診断用)。 */
  logWarn?: (data: Record<string, unknown>, msg: string) => void;
  /**
   * 情報観測フック(ADR-0035 D4。既定 no-op)。/ask 完了ごとに所要時間・ターン数を出し、
   * 探索予算・カタログ・並列化の判断材料にする。
   */
  logInfo?: (data: Record<string, unknown>, msg: string) => void;
  /** 進捗の購読(ADR-0035 D5。既定 no-op)。 */
  onProgress?: (ev: AskProgressEvent) => void;
  /** 実効の検索タイムアウト(ms)。タイムアウト文面の秒数表示に使う(既定 DEFAULT_ASK_TIMEOUT_MS)。 */
  searchTimeoutMs?: number;
  /**
   * bot の正常終了による中断(ADR-0035 追記)。abort されたら同期後・検索中のどこでも打ち切り、
   * `interrupted` として記録して INTERRUPTED_MESSAGE を返す。
   */
  signal?: AbortSignal;
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

/**
 * all_visible 有効時の /ask 用同期(ADR-0036 D5)。
 * - sync_on_ask のリポだけをリポ単位で同期する。KB の失敗は throw(従来どおり /ask はエラー)、
 *   それ以外の失敗は warn して clone の現状(前回同期の状態)で検索する。clone が無ければ対象外。
 * - 今回同期しないリポは定期同期の SyncedRepo → 無ければ `rev-parse HEAD` で解決する。
 *   引用の許可リストは「clone のある全対象リポ」から作る(今回同期分だけにするとコードのリポへの
 *   引用がすべて破棄される)。
 * 戻り: clone のあるリポ(manifest 用)と、その SyncedRepo(引用検証用)。同順。
 */
export async function syncForAskPerRepo(
  deps: Pick<AskDeps, "getRepos" | "syncer" | "logWarn" | "logInfo">,
  perRepo: PerRepoSyncDeps,
): Promise<{ available: ScopedRepo[]; synced: SyncedRepo[] }> {
  const { registry } = perRepo;
  const scope = deps.getRepos();
  const results = await deps.syncer.syncEach(scope.filter((r) => r.syncOnAsk));
  const fresh = new Map<string, SyncedRepo>();
  const failed = new Set<string>();
  for (const r of results) {
    if (r.status === "synced") {
      registry.recordSynced(r.synced);
      fresh.set(r.spec.repo, r.synced);
      continue;
    }
    if (r.status === "empty") {
      // commit の無い空リポ: 失敗ではない(warn しない)。manifest・allowlist から外すだけ。
      registry.recordEmpty(r.spec.repo);
      continue;
    }
    registry.recordError(r.spec.repo, r.error);
    if (r.spec.dir === perRepo.kbDir) throw r.error; // KB は members・鮮度確認の正本。従来どおりエラー
    failed.add(r.spec.repo);
    deps.logWarn?.(
      { repo: r.spec.repo, err: r.error },
      "/ask: リポの同期に失敗しました(clone の現状で検索します・ADR-0036 D5)",
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
  for (const spec of scope) {
    if (registry.isEmpty(spec.repo)) continue; // 空リポ(引用できるファイルが無い)
    let s = fresh.get(spec.repo);
    if (s === undefined && failed.has(spec.repo)) {
      // 失敗が fetch 後(reset/clean の途中)でも permalink が作業ツリーとズレないよう実 HEAD を使う。
      s = await head(spec);
    } else if (s === undefined) {
      s = registry.lastSynced(spec.repo);
      if (s === undefined) {
        s = await head(spec);
        if (s !== undefined) registry.recordSynced(s);
      }
    }
    if (s === undefined) continue; // clone 未取得(初回 clone 待ち)・壊れた clone は対象外
    available.push(spec);
    synced.push(s);
  }
  deps.logInfo?.(
    {
      inScope: scope.length,
      available: available.length,
      syncedNow: fresh.size,
      failed: failed.size,
    },
    "/ask: 検索範囲(ADR-0036)",
  );
  return { available, synced };
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
    deps.logInfo?.(
      { elapsedMs: Math.round(monoNow() - startedAt) },
      "/ask: 再起動のため中断しました(ADR-0035 追記)",
    );
    return { answerText: INTERRUPTED_MESSAGE, status: "interrupted", queryId };
  };
  try {
    if (isAborted()) return interrupted();
    deps.onProgress?.({ kind: "sync" });
    let repos: readonly RepoSpec[];
    let synced: SyncedRepo[];
    if (deps.perRepo !== undefined) {
      ({ available: repos, synced } = await syncForAskPerRepo(deps, deps.perRepo));
    } else {
      // 従来挙動(all_visible 無し): 全リポを同期し、1 リポでも失敗したら /ask 全体をエラーにする。
      repos = deps.getRepos();
      synced = await deps.syncer.sync(repos);
    }
    const prompt = await loadPrompt("qa", "answer", deps.promptStore);
    // §6.2: repo 対応表を前置きし、モデルが正しい org/name で引用できるようにする(PR-6a)。
    // all_visible 有効時は clone のあるリポだけを載せる(ADR-0036)。
    const manifest = buildRepoManifest(repos);
    const systemPrompt = manifest === "" ? prompt.body : `${manifest}\n${prompt.body}`;
    // git sync は中断できない(1 コマンド 60 秒の上限つき)ため、同期後に一度確かめてから検索に入る。
    if (isAborted()) return interrupted();
    deps.onProgress?.({ kind: "search" });
    const { value, usage, numTurns, durationApiMs, deniedToolCalls, requestedModel, actualModel } =
      await deps.search({
        systemPrompt,
        question: req.question,
        cwd: deps.clonesDir,
        ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
    // ADR-0035 D4: 所要時間とターン数を必ず残す(タイムアウト頻発の原因分析・探索予算の調整に使う)。
    deps.logInfo?.(
      {
        elapsedMs: Math.round(monoNow() - startedAt),
        numTurns: numTurns ?? null,
        durationApiMs: durationApiMs ?? null,
        // ADR-0037: 拒否されたツール呼び出し数(cwd 外読み取りの試行等。0 超は注入の兆候として追跡)。
        deniedToolCalls: deniedToolCalls ?? null,
        notFound: value.notFound,
        citations: value.citations.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        requestedModel: requestedModel ?? null,
        actualModel: actualModel ?? null,
      },
      "/ask: 検索完了",
    );
    // 組織の制限などで指定モデルが無通知で別モデルに置き換わっていないか(2026-10-01 の不具合の直接原因)。
    if (isModelSubstituted(requestedModel, actualModel)) {
      deps.logWarn?.(
        { requestedModel, actualModel },
        "/ask: 指定と異なるモデルが応答しました(組織のモデル制限による置き換えの可能性)",
      );
    }
    const valid = value.notFound
      ? []
      : validateCitations(
          value.citations,
          synced,
          deps.fileExists ?? existsSync,
          deps.readFile ?? defaultReadFile,
        );

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
    // タイムアウトは文面と answerStatus で明示する(§6.2 失敗時挙動 / ADR-0030 D3)。ナレッジ欠落
    // ではないので error 同様キューには積まない。code 直判定にするのは、isTransient だと withRetry
    // 済みの 429/529 まで拾ってしまい ERROR_MESSAGE(時間をおいて再度)のままが適切なため。
    // 中断(ABORTED)や、中断と同時に起きた失敗はエラーではなく interrupted として扱う。
    if ((err instanceof LlmError && err.code === "ABORTED") || isAborted()) {
      return interrupted();
    }
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
      elapsedMs: Math.round(monoNow() - startedAt),
    });
    return {
      answerText: timedOut
        ? timeoutMessage(deps.searchTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS)
        : ERROR_MESSAGE,
      status: timedOut ? "timeout" : "error",
      queryId,
    };
  }
}
