/**
 * Agent SDK(@anthropic-ai/claude-agent-sdk)による agentic search ラッパ(design.md §6.2 / §9.5)。
 * 本ファイルは Agent SDK を import する唯一の場所(CLAUDE.md §12.2)。
 *
 * 方針(導入版 0.3.179 の実型で確認 / ADR-0005 周辺の決定):
 * - permissionMode: "dontAsk" — 事前許可外ツールはプロンプトせず拒否(ヘッドレス Bot)
 * - settingSources: [] — FS の settings / CLAUDE.md を一切読まない(検索対象リポの .claude 混入排除)
 * - allowedTools: Read/Grep/Glob のみ。disallowedTools で危険ツールを明示拒否(belt-and-suspenders)
 * - outputFormat: { type:"json_schema", schema } — zod スキーマを zod-to-json-schema で変換して渡す
 * - 結果は SDKResultSuccess.structured_output(型 unknown)に出るため、必ず zod で再検証する
 * - timeout 相当は AbortController(Options に timeout は無い)。usage は result メッセージから記録
 *
 * ⚠️ セキュリティ境界(ADR-0006 / ADR-0037):
 *   `cwd` は SDK 上は FS の封じ込め境界ではない。素の `allowedTools:["Read",...]` は cwd 外の絶対パス・
 *   `../`・cwd 内から外を指す symlink もプロンプトなしで読ませる(本番 2026-09-30 に /config/ops.yaml の
 *   読み取りを実証)。そこで読み取り範囲を realpath(cwd) 配下に閉じ込める層を重ねる(ADR-0037):
 *   1. PreToolUse hook(自前コード・path-guard.ts): ファイル系ツールの対象 realpath が root 外なら **deny のみ**
 *   2. `settings.permissions.blockReadsOutsideWorkingDirectories: true`(SDK 側の強制。symlink も解決する)
 *   3. `tools` = allowedTools(基本ツール集合自体を絞る。ツール無し単発は StructuredOutput のみになる)
 *   これらはコンテナ層の隔離(別 uid 実行等・ADR-0006 D1)を置き換えるものではなく、その内側の多層防御。
 *
 * 事前起動(ADR-0042・`deps.prewarm` を渡したときだけ): SDK の `prewarm()`(@alpha)で次の 1 回分の subprocess を
 * 先に起動しておき、`claim()` で cwd と repo 対応表(appendSystemPrompt)だけを渡す。spawn 時に固定される hook・
 * プロセス内ツールは「claim した呼び出しの参照」を読む形にし、claim 外では deny / 拒否する(fail-closed)。
 * 使えないとき(準備の失敗・構成の不一致・claim の拒否)は従来の `query()` に倒す。
 */
import { createHash } from "node:crypto";
import {
  createSdkMcpServer,
  type HookCallback,
  type Options,
  prewarm,
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type ThinkingConfig,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { type ZodRawShape, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createSparePool,
  type PooledSpare,
  prewarmErrorLabel,
  type SparePool,
  type SparePoolOptions,
  type SparePoolState,
} from "./agent-prewarm.js";
import { LlmError, type LlmErrorCode } from "./errors.js";
import { type ModelRole, modelIdFor } from "./models.js";
import { checkToolPathContainment, type RealpathFn, resolveContainmentRoot } from "./path-guard.js";
import { nullUsageRecorder, type Usage, type UsageRecorder } from "./usage.js";

/** §9.5: Q&A エージェントの許可ツール(読み取り専用)。 */
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
/** 明示拒否(dontAsk + allowedTools 既定 deny の保険)。 */
export const DEFAULT_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

/**
 * agent subprocess に通す env の許可リスト(キー名)。SDK/ランタイムが必要とする無害な変数のみ。
 * これに加えて ANTHROPIC_ / CLAUDE_ / AWS_ 接頭辞のキーは素通しする(下記 buildAgentEnv)。
 * AWS_ は Claude Platform on AWS 認証(ADR-0008: AWS_REGION 等)に必要。
 */
const AGENT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * agent subprocess に渡す最小 env を組む(§9.1 / ADR-0006)。
 * SDK の Options.env は process.env を**置換**する(マージしない)ため、許可リストのキーと
 * ANTHROPIC_ / CLAUDE_ / AWS_ 接頭辞だけを通し、DISCORD_TOKEN・GITHUB_TOKEN 等の秘密は subprocess へ渡さない
 * (`/proc/self/environ` 経由のトークン漏洩ベクタを塞ぐ)。AWS_ は Claude Platform on AWS 認証に必要なため通す(ADR-0008)。
 * ファイル読み取り自体の封じ込めは別途 OS/コンテナ FS サンドボックス(ADR-0006、Phase 1b デプロイ要件)に依存する。
 */
export function buildAgentEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(source)) {
    if (
      v !== undefined &&
      (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_") || k.startsWith("AWS_"))
    ) {
      env[k] = v;
    }
  }
  return env;
}

/**
 * agentic search の進捗イベント(ADR-0035 D5)。ツール名と通番のみを載せ、パス・引数・出力は
 * 渡さない(検索対象の内容を UI 側へ漏らす面を増やさない)。
 */
export interface AgentProgressEvent {
  kind: "tool_use";
  /** 呼び出されたツール名(Read / Grep / Glob 等)。 */
  tool: string;
  /** 何ターン目の assistant メッセージか(1 始まり)。 */
  turn: number;
}

/**
 * 推論の努力度(ADR-0035 D6 の実験ノブ)。SDK の EffortLevel のうち運用で使う範囲だけを公開し、
 * アプリ側が Agent SDK の型に依存しないようにする(CLAUDE.md: SDK import は本ファイルのみ)。
 */
export type AgentEffort = "low" | "medium" | "high";
/** 拡張思考の有無(ADR-0035 D6 の実験ノブ)。未指定なら SDK 既定。 */
export type AgentThinking = "adaptive" | "disabled";

/**
 * 呼び出し元が渡すプロセス内ツール(ADR-0038 D6。SDK のプロセス内 MCP サーバとして載せる)。
 * アプリ側が Agent SDK / MCP の型に依存しないよう、形は {@link defineInProcessTool} で作る。
 * handler の戻り値はモデルへ返すテキスト。例外はツールのエラー結果としてモデルへ返し、検索自体は止めない。
 */
export interface AgentInProcessTool {
  name: string;
  description: string;
  /** 入力の zod raw shape(z.object の中身)。SDK が JSON Schema 化してモデルに見せる。 */
  inputShape: ZodRawShape;
  /** 入力は handler 内で再検証済み(SDK 側の検証と二重)。 */
  handler: (args: unknown) => Promise<string>;
}

/** プロセス内ツールを載せる MCP サーバ名(固定)。モデルから見えるツール名は `mcp__<server>__<name>`。 */
export const IN_PROCESS_MCP_SERVER = "stratum";
/** プロセス内ツールの呼び出し上限 ms(固定クエリ・読み取り専用のため通常は ms 単位で終わる)。 */
const IN_PROCESS_TOOL_TIMEOUT_MS = 30_000;
const IN_PROCESS_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** モデル・allowedTools から見えるプロセス内ツールの完全名。 */
export function inProcessToolName(name: string): string {
  return `mcp__${IN_PROCESS_MCP_SERVER}__${name}`;
}

/**
 * プロセス内ツールを定義する(ADR-0038 D6)。入力は zod で検証してから handler に渡す。
 * 名前は英小文字・数字・`_` のみ(ツール名の衝突・MCP 名の正規化による取り違えを避ける)。
 */
export function defineInProcessTool<S extends ZodRawShape>(def: {
  name: string;
  description: string;
  inputShape: S;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>;
}): AgentInProcessTool {
  if (!IN_PROCESS_TOOL_NAME_RE.test(def.name)) {
    throw new Error(`プロセス内ツール名が不正です: ${def.name}`);
  }
  const schema = z.object(def.inputShape);
  return {
    name: def.name,
    description: def.description,
    inputShape: def.inputShape,
    handler: async (args) => def.handler(schema.parse(args)),
  };
}

/** 事前起動した spare のプロセス内ツールが、claim の外(または claim した呼び出しが渡していない)で呼ばれた。 */
class InProcessToolUnavailableError extends Error {
  override readonly name = "InProcessToolUnavailableError";
}

/** プロセス内ツール群を SDK の MCP サーバ設定にする(読み取り専用の注記・遅延ロードしない)。 */
function inProcessMcpServer(tools: readonly AgentInProcessTool[]) {
  return createSdkMcpServer({
    name: IN_PROCESS_MCP_SERVER,
    version: "1.0.0",
    // ToolSearch は基本ツール集合に無いため、遅延ロードされると呼べなくなる。
    alwaysLoad: true,
    timeout: IN_PROCESS_TOOL_TIMEOUT_MS,
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.inputShape,
        async (args) => {
          try {
            return { content: [{ type: "text" as const, text: await t.handler(args) }] };
          } catch (err) {
            const reason =
              err instanceof z.ZodError
                ? "入力が不正です"
                : err instanceof InProcessToolUnavailableError
                  ? "このツールは現在使えません"
                  : "ツールの実行に失敗しました";
            return { content: [{ type: "text" as const, text: reason }], isError: true };
          }
        },
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),
    ),
  });
}

export interface AgentSearchOptions<T> {
  /** UsageRecorder のラベル(アプリ名)。 */
  app: string;
  /** モデルロール(§5.2)。モデル ID は models.ts から解決する。 */
  role: ModelRole;
  /** system prompt 本文(loadPrompt で読んだ body)。呼び出しをまたいで変わらない静的な部分を置く。 */
  systemPrompt: string;
  /**
   * system prompt の後半に置く、呼び出しごとに変わりうる部分(/ask の repo 対応表など)。
   * 空でなければ SDK の `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` で `systemPrompt` と分けて渡し、静的な前半だけを
   * セッションをまたぐプロンプトキャッシュの対象にする(後半が変わっても前半のキャッシュは効く)。
   * 未指定・空なら従来どおり `systemPrompt` の文字列 1 つを渡す。
   */
  systemPromptDynamic?: string;
  /** ユーザの質問。 */
  prompt: string;
  /** 検索対象のローカル clone ルート(cwd)。 */
  cwd: string;
  /** 構造化出力の zod スキーマ。structured_output をこれで再検証する。 */
  outputSchema: z.ZodType<T>;
  /** 許可ツール。既定 Read/Grep/Glob(§9.5)。 */
  allowedTools?: readonly string[];
  /** 最大ターン数。既定 30。 */
  maxTurns?: number;
  /** タイムアウト(ms)。既定 120000(§6.2)。AbortController で実装。 */
  timeoutMs?: number;
  /** 進捗の購読(ADR-0035 D5)。listener の例外は握って検索を止めない。 */
  onProgress?: (ev: AgentProgressEvent) => void;
  /**
   * 呼び出し側からの中断(bot の正常終了・ADR-0035 追記)。abort されると検索を打ち切り
   * LlmError("ABORTED") を投げる。内部のタイムアウト(TIMEOUT)とは区別する。
   */
  signal?: AbortSignal;
  /** 努力度(未指定なら SDK 既定)。所要時間と回答品質のトレードオフ調整用(ADR-0035 D6)。 */
  effort?: AgentEffort;
  /** 拡張思考(未指定なら SDK 既定)。 */
  thinking?: AgentThinking;
  /**
   * 1 回の実行の使用量の購読(段階 1-1・費用の合算用)。result メッセージを受け取ったら成否に関係なく
   * 1 回だけ呼ぶ(形式エラー等で throw する回の費用も拾えるように)。result が無い(タイムアウト等)
   * なら呼ばない。listener の例外は握る。
   */
  onUsage?: (u: AgentRunUsage) => void;
  /**
   * プロセス内ツール(ADR-0038 D6)。渡したときだけ `mcpServers` に載せ、`allowedTools` に個別に加える。
   * 基本ツール集合(`tools`)と封じ込め hook は変えない(hook はファイル系ツールだけを判定する)。
   */
  inProcessTools?: readonly AgentInProcessTool[];
}

/** 1 回の実行の使用量(onUsage)。キャッシュ・費用は result に無ければキー自体を持たない。 */
export interface AgentRunUsage {
  /** キャッシュ分を含まない入力トークン(input_tokens)。 */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalCostUsd?: number;
  modelUsage?: Record<string, AgentModelUsage>;
}

export interface AgentSearchResult<T> {
  /** zod 検証済みの構造化出力。 */
  value: T;
  /** 入出力トークン(§7.3)。 */
  usage: Usage;
  /** Agent SDK が消費したターン数(観測用・ADR-0035 D4。result に無ければ undefined)。 */
  numTurns?: number;
  /** モデル API 呼び出しの合計時間 ms(観測用・ADR-0035 D4)。 */
  durationApiMs?: number;
  /**
   * 拒否されたツール呼び出し数(result.permission_denials。封じ込め hook・dontAsk 拒否を含む)。
   * 観測用(ADR-0037): 0 超は cwd 外読み取りの試行やツール誤用のシグナル。result に無ければ undefined。
   */
  deniedToolCalls?: number;
  /** 指定したモデル ID(models.ts の解決結果)。runAgentSearch は常に入れる(テスト用の差し替えでは省略可)。 */
  requestedModel?: string;
  /**
   * 実際に応答したモデル ID(assistant メッセージの message.model・最初の 1 件)。組織の制限で指定モデルが
   * 使えないと SDK は無通知で別モデルに置き換えるため、requestedModel と比べて検出する(2026-10-01 の
   * 「test」回答の不具合の直接原因)。assistant メッセージが無ければ undefined。
   */
  actualModel?: string;
  /**
   * キャッシュ作成に回った入力トークン(result.usage.cache_creation_input_tokens・観測用)。
   * 注意: `usage.inputTokens`(input_tokens)はキャッシュ分を**含まない**。プロンプト入力の総量は
   * inputTokens + cacheCreationInputTokens + cacheReadInputTokens。result.usage は SDK の仕様上
   * メインのエージェントループ分だけなので、費用・トークンの集計には modelUsage を優先する。
   */
  cacheCreationInputTokens?: number;
  /** キャッシュから読んだ入力トークン(result.usage.cache_read_input_tokens・観測用)。 */
  cacheReadInputTokens?: number;
  /** SDK が見積もった合計費用 USD(result.total_cost_usd。請求額ではなく推定値)。 */
  totalCostUsd?: number;
  /** モデル別の使用量(result.modelUsage を必要な数値だけに絞ったもの・観測用)。 */
  modelUsage?: Record<string, AgentModelUsage>;
  /**
   * query() の開始から最初の SDK メッセージ(通常 system init)までの ms(subprocess の起動コスト・観測用)。
   * 事前起動した subprocess を使ったとき(prewarmed)は claim から最初のメッセージまで。
   * メッセージが 1 件も無ければ undefined。
   */
  startupMs?: number;
  /**
   * 事前起動した subprocess を claim して検索したか(ADR-0042・観測用)。runAgentSearch は常に入れる
   * (事前起動が無効・使えず従来の query() で起動したら false)。
   */
  prewarmed?: boolean;
  /**
   * ツール名ごとの呼び出し回数(assistant の tool_use ブロックを数えたもの・観測用)。プロセス内ツールは
   * `mcp__stratum__` を外した名前(例 discord_search)。引数・パス・出力は持たない。
   */
  toolCalls?: Record<string, number>;
  /** 2 つ以上の tool_use を含んだ API 応答(= 並列にツールを呼んだターン)の数(観測用)。 */
  parallelTurns?: number;
  /**
   * 最初の API 応答のキャッシュ読み取り / 作成トークン(assistant の message.usage・参考値)。
   * system prompt・ツール定義の前半がキャッシュに当たったかを見る。usage が無ければ undefined。
   */
  firstTurnCacheRead?: number;
  firstTurnCacheCreation?: number;
}

/**
 * モデル別の使用量(SDK の ModelUsage から数値だけを抜いたもの)。
 * inputTokens はキャッシュ分を含まない(cacheReadInputTokens / cacheCreationInputTokens は別計上)。
 */
export interface AgentModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/** 有限の数値だけを通す(SDK の値の型崩れ・NaN をログへ流さない)。 */
function finiteOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * result.modelUsage を観測用に整える(SDK 0.3.285 の ModelUsage: inputTokens / outputTokens /
 * cacheReadInputTokens / cacheCreationInputTokens / costUSD …)。数値以外のフィールド
 * (provider・costBasis 等)は落とし、欠けた数値は 0 にする。形が違えば undefined。
 */
export function sanitizeModelUsage(raw: unknown): Record<string, AgentModelUsage> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, AgentModelUsage> = {};
  for (const [model, u] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof u !== "object" || u === null) continue;
    const r = u as Record<string, unknown>;
    out[model] = {
      inputTokens: finiteOrUndefined(r.inputTokens) ?? 0,
      outputTokens: finiteOrUndefined(r.outputTokens) ?? 0,
      cacheReadInputTokens: finiteOrUndefined(r.cacheReadInputTokens) ?? 0,
      cacheCreationInputTokens: finiteOrUndefined(r.cacheCreationInputTokens) ?? 0,
      costUsd: finiteOrUndefined(r.costUSD) ?? 0,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 指定モデルと実モデルが食い違うか(実モデルが不明なら false)。日付付き ID 等の派生
 * (例: claude-sonnet-5-5-20260901)は同一とみなすため前方一致で比べる。
 */
export function isModelSubstituted(
  requested: string | undefined,
  actual: string | undefined,
): boolean {
  return requested !== undefined && actual !== undefined && !actual.startsWith(requested);
}

/** query() の最小シグネチャ。注入で Agent SDK をモック可能にする(kb-core の IO 注入と同趣旨)。 */
export type AgentQueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<unknown>;

/** runAgentSearch の依存(注入)。 */
export interface LlmDeps {
  /** Agent SDK query() の差し替え(テスト用)。既定は実 SDK。 */
  queryFn?: AgentQueryFn;
  /** usage 記録先。既定は no-op。 */
  usage?: UsageRecorder;
  /** 単調クロック ms(startupMs の計測用。既定 performance.now・テストで差し替え)。 */
  monotonicMs?: () => number;
  /**
   * subprocess の事前起動(ADR-0042)。渡したときだけ、待機中の spare を claim して検索し、終わったら次の 1 本を
   * バックグラウンドで用意する。未指定 = 従来どおり毎回 query() で起動する。
   */
  prewarm?: AgentPrewarmPool;
}

const defaultQueryFn: AgentQueryFn = (params) => query(params);

/** claim で渡す呼び出しごとの設定(SDK の ClaimOptions のうち使う部分)。 */
export interface AgentClaimOptions {
  cwd: string;
  appendSystemPrompt?: string;
}

/**
 * 事前起動した subprocess(SDK の SpareProcess の必要部分・ADR-0042)。テストで差し替えられるよう最小形にする。
 * claim は 1 回だけ。claimed は claim の受理で resolve、拒否(cwd_not_found 等)で reject する。
 */
export interface AgentSpareProcess {
  claim(params: { prompt: string; options: AgentClaimOptions }): AsyncIterable<unknown>;
  readonly claimed: Promise<unknown>;
  readonly exited: Promise<void>;
  close(): void;
}

/** SDK prewarm() の最小シグネチャ(注入でモック)。 */
export type AgentPrewarmFn = (params: { options: Options }) => Promise<AgentSpareProcess>;

/** prewarm() の initialize 待ちの上限 ms(SDK 既定 60 秒より短くし、失敗を早く従来経路へ倒す)。 */
const PREWARM_INITIALIZE_TIMEOUT_MS = 30_000;
/** claim の受理を待つ上限 ms(通常は 1 往復。超えたら spare を閉じて従来経路へ)。 */
const CLAIM_TIMEOUT_MS = 15_000;

const defaultPrewarmFn: AgentPrewarmFn = (params) =>
  prewarm({ options: params.options, initializeTimeoutMs: PREWARM_INITIALIZE_TIMEOUT_MS });

/**
 * spare を claim した呼び出しの参照(ADR-0042 D3/D5)。spawn 時に固定される hook とプロセス内ツールはこれだけを読む。
 * claim 前・終了後は active=false(hook は全ツールを deny、プロセス内ツールは拒否)。spare は 1 回限りなので、
 * この参照も 1 つの呼び出しにしか結び付かない。
 */
interface ClaimContext {
  active: boolean;
  /** claim した呼び出しの realpath(cwd)。 */
  root: string | undefined;
  /** claim した呼び出しが渡したプロセス内ツールの handler(名前 → handler)。 */
  tools: Map<string, (args: unknown) => Promise<string>>;
}

/** 預かる spare(SDK のプロセス + claim の参照 + spare 固有の abortController)。 */
interface WarmSpare extends PooledSpare {
  spare: AgentSpareProcess;
  ctx: ClaimContext;
  abortController: AbortController;
}

/**
 * 事前起動の入れ物(ADR-0042)。bot のプロセスで 1 つ作り、runAgentSearch の deps.prewarm に渡す。
 * 中身(spare の型)は公開しない。
 */
export interface AgentPrewarmPool {
  /** 待機中・準備中の spare を閉じ、以後は事前起動しない(正常終了用)。 */
  dispose(): Promise<void>;
  /** 観測・テスト用(empty / warming / ready / disposed)。 */
  state(): SparePoolState;
}

interface PrewarmInternals {
  pool: SparePool<WarmSpare>;
  prewarmFn: AgentPrewarmFn;
}

const prewarmInternals = new WeakMap<AgentPrewarmPool, PrewarmInternals>();

export interface AgentPrewarmPoolOptions extends SparePoolOptions {
  /** SDK prewarm() の差し替え(テスト用)。既定は実 SDK。 */
  prewarmFn?: AgentPrewarmFn;
}

/** 事前起動の入れ物を作る(ADR-0042)。作っただけでは起動しない(最初の検索が終わったときに 1 本用意する)。 */
export function createAgentPrewarmPool(opts: AgentPrewarmPoolOptions = {}): AgentPrewarmPool {
  const { prewarmFn, ...poolOpts } = opts;
  const pool = createSparePool<WarmSpare>(poolOpts);
  const handle: AgentPrewarmPool = { dispose: () => pool.dispose(), state: () => pool.state() };
  prewarmInternals.set(handle, { pool, prewarmFn: prewarmFn ?? defaultPrewarmFn });
  return handle;
}

/** 公開型 AgentThinking → SDK ThinkingConfig。 */
function thinkingConfigOf(t: AgentThinking): ThinkingConfig {
  return t === "disabled" ? { type: "disabled" } : { type: "adaptive" };
}

/** Agent SDK の終端 result メッセージ(必要部分のみ)。 */
interface ResultMessage {
  type: "result";
  subtype: string;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  num_turns?: number;
  duration_api_ms?: number;
  permission_denials?: unknown[];
  total_cost_usd?: number;
  modelUsage?: unknown;
}

/** Agent SDK の assistant メッセージ(tool_use ブロック抽出に必要な部分のみ)。 */
interface AssistantMessage {
  type: "assistant";
  message?: { id?: unknown; content?: unknown; model?: unknown; usage?: unknown };
}

function isAssistantMessage(m: unknown): m is AssistantMessage {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "assistant";
}

/** assistant メッセージ本文から tool_use ブロックのツール名だけを抜く。 */
export function toolNamesOf(m: AssistantMessage): string[] {
  const content = m.message?.content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_use" &&
      typeof (block as { name?: unknown }).name === "string"
    ) {
      names.push((block as { name: string }).name);
    }
  }
  return names;
}

/** ログに載せてよいツール名(英数字・`_`・`-` のみ)。それ以外は "other" に畳む。 */
const LOGGABLE_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IN_PROCESS_TOOL_PREFIX = `mcp__${IN_PROCESS_MCP_SERVER}__`;

/** 観測用のツール名(プロセス内ツールは接頭辞を外す。想定外の名前は "other")。 */
function loggableToolName(name: string): string {
  const short = name.startsWith(IN_PROCESS_TOOL_PREFIX)
    ? name.slice(IN_PROCESS_TOOL_PREFIX.length)
    : name;
  return LOGGABLE_TOOL_NAME_RE.test(short) ? short : "other";
}

/** 1 回の実行のツール利用の集計(観測用)。 */
interface AgentToolStats {
  toolCalls: Record<string, number>;
  parallelTurns: number;
}

/**
 * SDK のメッセージ列からツール利用を集計する(観測用)。SDK はストリーム中、1 つの API 応答を
 * content ブロックごとの assistant メッセージに分けて流す(同じ message.id を共有する)ため、
 * 並列呼び出しの判定は message.id ごとに tool_use を数える。id が無いメッセージは 1 件を 1 応答とみなす。
 */
function createToolStatsCollector(): {
  add(m: AssistantMessage): void;
  stats(): AgentToolStats;
} {
  const toolCalls: Record<string, number> = {};
  const perResponse = new Map<unknown, number>();
  return {
    add(m) {
      const names = toolNamesOf(m);
      if (names.length === 0) return;
      for (const n of names) {
        const k = loggableToolName(n);
        toolCalls[k] = (toolCalls[k] ?? 0) + 1;
      }
      const id = m.message?.id;
      const key = typeof id === "string" && id !== "" ? id : Symbol();
      perResponse.set(key, (perResponse.get(key) ?? 0) + names.length);
    },
    stats: () => ({
      toolCalls: { ...toolCalls },
      parallelTurns: [...perResponse.values()].filter((n) => n >= 2).length,
    }),
  };
}

/** assistant メッセージの message.usage からキャッシュ読み取り / 作成トークンを抜く(無ければ undefined)。 */
function cacheUsageOf(
  m: AssistantMessage,
): { read: number | undefined; creation: number | undefined } | undefined {
  const u = m.message?.usage;
  if (typeof u !== "object" || u === null) return undefined;
  const r = u as Record<string, unknown>;
  return {
    read: finiteOrUndefined(r.cache_read_input_tokens),
    creation: finiteOrUndefined(r.cache_creation_input_tokens),
  };
}

function isResultMessage(m: unknown): m is ResultMessage {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "result";
}

/** PreToolUse の deny 応答(allow は決して返さない)。 */
function denyOutput(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * 封じ込め hook の本体(ADR-0037)。判定ルートは getRoot から読む。undefined の間(事前起動した spare の
 * claim 前・終了後・ADR-0042 D3)は、どのツール呼び出しも deny する(fail-closed)。
 */
function containmentHookOf(getRoot: () => string | undefined, realpath?: RealpathFn): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const root = getRoot();
    if (root === undefined) {
      return denyOutput(`${input.tool_name}: 検索の実行中ではないため拒否しました`);
    }
    let reason: string | undefined;
    try {
      const d = checkToolPathContainment(input.tool_name, input.tool_input, root, realpath);
      if (!d.allowed) reason = d.reason;
    } catch {
      reason = `${input.tool_name}: パス判定に失敗したため拒否しました`;
    }
    return reason === undefined ? {} : denyOutput(reason);
  };
}

/**
 * 読み取り封じ込めの PreToolUse hook を作る(ADR-0037)。root = realpath(cwd) を生成時に 1 回だけ解決し、
 * ファイル系ツールの対象 realpath が root 外なら deny を返す。**allow は決して返さない**(判定を
 * permission 系へ委ねる `{}` か deny のみ)ため、hook が能力を再導入することはない。
 * 判定中の想定外例外はファイル系ツールに限り deny に倒す(fail-closed)。
 */
export function createContainmentHook(cwd: string, realpath?: RealpathFn): HookCallback {
  const root = resolveContainmentRoot(cwd, realpath);
  return containmentHookOf(() => root, realpath);
}

/** プロセス内ツールの定義だけ(handler を持たない。spare に前の呼び出しの handler を残さないため)。 */
interface InProcessToolDef {
  name: string;
  description: string;
  inputShape: ZodRawShape;
}

/**
 * spawn 時に固定される構成(ADR-0042 D2)。事前起動した spare はこれが一致する呼び出しにだけ使う。
 * 呼び出しごとの値(prompt・cwd・repo 対応表・ツールの handler・signal・listener)は持たない。
 */
interface SearchSpec {
  systemPrompt: string;
  requestedModel: string;
  schema: Record<string, unknown>;
  allowedTools: readonly string[];
  maxTurns: number;
  effort: AgentEffort | undefined;
  thinking: AgentThinking | undefined;
  toolDefs: readonly InProcessToolDef[];
  /** buildAgentEnv の結果(subprocess は起動時に読む)。 */
  env: Record<string, string>;
}

/**
 * 構成の指紋(ADR-0042 D2)。spare と呼び出しの構成が一致するかの比較だけに使う。env(認証情報を含む)を
 * 含めるため、値はメモリ上でだけ使いログには出さない。
 */
function specKeyOf(spec: SearchSpec): string {
  const tools = spec.toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    input: zodToJsonSchema(z.object(t.inputShape), { $refStrategy: "none" }),
  }));
  // CLAUDE_AGENT_SDK_VERSION は SDK が query() / prewarm() のたびに process.env へ書く(0.3.285 の実装)。
  // 最初の起動の前後で値の有無が変わり、指紋が一致しなくなるため除く(spawn 時には SDK が必ず同じ値を入れる)。
  const env = Object.entries(spec.env)
    .filter(([k]) => k !== "CLAUDE_AGENT_SDK_VERSION")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify({
        systemPrompt: spec.systemPrompt,
        model: spec.requestedModel,
        schema: spec.schema,
        allowedTools: spec.allowedTools,
        maxTurns: spec.maxTurns,
        effort: spec.effort ?? null,
        thinking: spec.thinking ?? null,
        tools,
        env,
      }),
    )
    .digest("hex");
}

/**
 * query() / prewarm() に渡す Options を組む。従来経路と事前起動で同じ封じ込め設定を共有する
 * (違いは system prompt の形・cwd の有無・hook とプロセス内ツールの実体・abortController だけ)。
 */
function searchOptionsOf(
  spec: SearchSpec,
  parts: {
    systemPrompt: Options["systemPrompt"];
    /** 事前起動では渡さない(SDK が待機用ディレクトリを使い、claim で作業ディレクトリを渡す)。 */
    cwd?: string;
    hook: HookCallback;
    inProcessTools: readonly AgentInProcessTool[];
    abortController: AbortController;
  },
): Options {
  // ツール能力の封じ込め: permissionMode:"dontAsk"(未承認ツールはプロンプトせず拒否)+ allowedTools 許可リスト
  // + tools で基本ツール集合自体を allowedTools に絞る(allowedTools:[] でも既定では cwd 配下の Read/Grep/Glob が
  // 通るため・ADR-0037 実験)。disallowedTools は冗長な明示拒否。
  // 読み取り範囲の封じ込め(ADR-0037): deny のみを返す PreToolUse hook + SDK の
  // blockReadsOutsideWorkingDirectories。agents / canUseTool / toolAliases / additionalDirectories は
  // 能力・到達範囲を広げうるため意図的に未設定のまま維持する(§9.5)。mcpServers は呼び出し元が明示的に渡した
  // プロセス内ツールだけ(ADR-0038 D6 の例外。外部の MCP サーバは載せず、strictMcpConfig で外部設定も読まない)。
  const inProcessNames = parts.inProcessTools.map((t) => inProcessToolName(t.name));
  return {
    systemPrompt: parts.systemPrompt,
    model: spec.requestedModel,
    ...(parts.cwd !== undefined ? { cwd: parts.cwd } : {}),
    permissionMode: "dontAsk",
    settingSources: [],
    // 会話記録(検索で読んだ社内文書の本文を含む)を ~/.claude/projects に残さない(2026-10-01)。
    persistSession: false,
    tools: [...spec.allowedTools],
    allowedTools: [...spec.allowedTools, ...inProcessNames],
    ...(parts.inProcessTools.length > 0
      ? {
          mcpServers: { [IN_PROCESS_MCP_SERVER]: inProcessMcpServer(parts.inProcessTools) },
          strictMcpConfig: true,
        }
      : {}),
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    // flag 設定層(settingSources:[] でも適用される)。managedSettings は IT 管理設定がある環境で
    // 既定で捨てられるため使わない(ADR-0037)。
    settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
    hooks: { PreToolUse: [{ hooks: [parts.hook] }] },
    // §9.1 / ADR-0006: subprocess env を最小許可リストに置換し、DISCORD_TOKEN 等を渡さない。
    env: spec.env,
    outputFormat: { type: "json_schema", schema: spec.schema },
    maxTurns: spec.maxTurns,
    abortController: parts.abortController,
    // ADR-0035 D6: 実験ノブ。未指定時はキー自体を渡さず SDK 既定に委ねる(挙動不変)。
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    ...(spec.thinking !== undefined ? { thinking: thinkingConfigOf(spec.thinking) } : {}),
  };
}

/**
 * spare に載せるプロセス内ツール(ADR-0042 D5)。定義だけを持ち、実行は claim した呼び出しが渡した同名の
 * handler へ委ねる。claim の外・その呼び出しが渡していないツールは拒否する(何も実行しない)。
 */
function delegatingTool(def: InProcessToolDef, ctx: ClaimContext): AgentInProcessTool {
  return {
    name: def.name,
    description: def.description,
    inputShape: def.inputShape,
    handler: async (args) => {
      const handler = ctx.active ? ctx.tools.get(def.name) : undefined;
      if (handler === undefined) throw new InProcessToolUnavailableError(def.name);
      return handler(args);
    },
  };
}

/** spare を 1 本起動する(ADR-0042)。hook とプロセス内ツールは claim の参照(ctx)だけを読む。 */
async function spawnWarmSpare(prewarmFn: AgentPrewarmFn, spec: SearchSpec): Promise<WarmSpare> {
  const ctx: ClaimContext = { active: false, root: undefined, tools: new Map() };
  const abortController = new AbortController();
  const options = searchOptionsOf(spec, {
    // repo 対応表は claim の appendSystemPrompt で境界の後ろに足す(ADR-0042 D4)。
    systemPrompt: [spec.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
    hook: containmentHookOf(() => (ctx.active ? ctx.root : undefined)),
    inProcessTools: spec.toolDefs.map((d) => delegatingTool(d, ctx)),
    abortController,
  });
  const spare = await prewarmFn({ options });
  return {
    spare,
    ctx,
    abortController,
    exited: spare.exited,
    close: () => {
      // 参照を外してから閉じる(以後 hook は deny・プロセス内ツールは拒否)。
      ctx.active = false;
      ctx.root = undefined;
      ctx.tools.clear();
      spare.close();
    },
  };
}

type ClaimOutcome = { ok: true } | { ok: false; reason: string };

/**
 * claim の受理を待つ。拒否(cwd_not_found 等)・上限超えは ok:false(呼び出し側は従来経路へ倒す)。
 * 中断・タイムアウトで signal が abort されたら throw する(呼び出し側の catch が TIMEOUT / ABORTED に分ける)。
 */
async function awaitClaim(claimed: Promise<unknown>, signal: AbortSignal): Promise<ClaimOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<ClaimOutcome>((resolve, reject) => {
      onAbort = () => reject(new Error("aborted"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => resolve({ ok: false, reason: "claim_timeout" }), CLAIM_TIMEOUT_MS);
      claimed.then(
        () => resolve({ ok: true }),
        (err: unknown) => {
          // option_not_applied は model / maxThinkingTokens だけが拒否されたもので、セッションは走っている
          // (どちらも claim では渡していないため通常は起きない)。
          const reason = prewarmErrorLabel(err);
          resolve(reason === "option_not_applied" ? { ok: true } : { ok: false, reason });
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 質問に対して agentic search を実行し、構造化出力を zod 検証して返す。
 * 許可ツールは Read/Grep/Glob のみ、設定は読み込まない(§9.5)。usage は常に記録する。
 * deps.prewarm があれば、待機中の spare を claim して使い、終わったら次の 1 本を用意する(ADR-0042)。
 */
export async function runAgentSearch<T>(
  opts: AgentSearchOptions<T>,
  deps: LlmDeps = {},
): Promise<AgentSearchResult<T>> {
  const queryFn = deps.queryFn ?? defaultQueryFn;
  const usageRecorder = deps.usage ?? nullUsageRecorder;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // $refStrategy:"none" で $ref ラップを避け、root を素の type:"object" schema にする。
  const schema = zodToJsonSchema(opts.outputSchema, { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;

  // 呼び出し側の中断は検索を始める前に判定する(subprocess を起動しない)。
  if (opts.signal?.aborted === true) {
    throw new LlmError("ABORTED", "Agent SDK query は開始前に中断されました");
  }

  const requestedModel = modelIdFor(opts.role);
  const inProcessTools = opts.inProcessTools ?? [];
  const spec: SearchSpec = {
    systemPrompt: opts.systemPrompt,
    requestedModel,
    schema,
    allowedTools: opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    maxTurns: opts.maxTurns ?? 30,
    effort: opts.effort,
    thinking: opts.thinking,
    toolDefs: inProcessTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputShape: t.inputShape,
    })),
    env: buildAgentEnv(),
  };
  // 静的な本文 → 境界 → 呼び出しごとに変わる部分(manifest 等)の順にし、前半をキャッシュに残す。
  const dynamic = opts.systemPromptDynamic ?? "";

  // ADR-0042: 構成が一致する待機中の spare を取り出す(準備中なら少しだけ待つ)。
  const pre = deps.prewarm !== undefined ? prewarmInternals.get(deps.prewarm) : undefined;
  const specKey = pre !== undefined ? specKeyOf(spec) : "";
  let warm = pre !== undefined ? await pre.pool.take(specKey) : undefined;
  // 待っている間の中断(関数にするのは、await をまたいだ再判定を型の絞り込みに潰されないようにするため)。
  const callerAborted = (): boolean => opts.signal?.aborted === true;
  if (callerAborted()) {
    warm?.close();
    throw new LlmError("ABORTED", "Agent SDK query は開始前に中断されました");
  }

  // 内部の AbortController はタイムアウトと呼び出し側の中断の両方で abort する。
  // どちらで止めたかは abortedByCaller で区別する(TIMEOUT と ABORTED で文面・記録が違うため)。
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  let abortedByCaller = false;
  const onCallerAbort = (): void => {
    abortedByCaller = true;
    abortController.abort();
  };
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let result: ResultMessage | undefined;
  let turn = 0;
  let actualModel: string | undefined;
  // 観測用(/ask 高速化の計測): 起動コスト・ツール利用・最初の応答のキャッシュ。
  const clock = deps.monotonicMs ?? (() => performance.now());
  let startupMs: number | undefined;
  let firstTurnCache: { read: number | undefined; creation: number | undefined } | undefined;
  const toolStats = createToolStatsCollector();
  let prewarmed = false;
  try {
    let stream: AsyncIterable<unknown> | undefined;
    let startedAt = 0;
    if (warm !== undefined) {
      const w = warm;
      // タイムアウト・呼び出し側の中断を spare 固有の controller(spawn 時に固定)へ伝える。
      abortController.signal.addEventListener("abort", () => w.abortController.abort(), {
        once: true,
      });
      // ADR-0042 D3/D5: claim の参照を、この呼び出しの root とプロセス内ツールに結び付ける。
      w.ctx.root = resolveContainmentRoot(opts.cwd);
      for (const t of inProcessTools) w.ctx.tools.set(t.name, t.handler);
      w.ctx.active = true;
      let outcome: ClaimOutcome;
      startedAt = clock();
      try {
        const q = w.spare.claim({
          prompt: opts.prompt,
          // ADR-0042 D4: repo 対応表は appendSystemPrompt(静的本文 → 境界 → 対応表 の並びになる)。
          options: { cwd: opts.cwd, ...(dynamic !== "" ? { appendSystemPrompt: dynamic } : {}) },
        });
        outcome = await awaitClaim(w.spare.claimed, abortController.signal);
        if (outcome.ok) stream = q;
      } catch (err) {
        if (abortController.signal.aborted) throw err;
        outcome = { ok: false, reason: prewarmErrorLabel(err) };
      }
      if (outcome.ok) {
        prewarmed = true;
      } else {
        // 拒否された spare の prompt は実行されていない(SDK の仕様)。閉じて従来経路で起動し直す。
        w.close();
        warm = undefined;
        pre?.pool.warnOnce(
          "claim_refused",
          { reason: outcome.reason },
          "/ask: 事前起動した subprocess を使えなかったため通常の起動で検索します(ADR-0042)",
        );
      }
    }
    if (stream === undefined) {
      const options = searchOptionsOf(spec, {
        systemPrompt:
          dynamic === ""
            ? opts.systemPrompt
            : [opts.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamic],
        cwd: opts.cwd,
        hook: createContainmentHook(opts.cwd),
        inProcessTools,
        abortController,
      });
      startedAt = clock();
      stream = queryFn({ prompt: opts.prompt, options });
    }
    for await (const msg of stream) {
      startupMs ??= Math.round(clock() - startedAt);
      if (isResultMessage(msg)) result = msg;
      else if (isAssistantMessage(msg)) {
        toolStats.add(msg);
        firstTurnCache ??= cacheUsageOf(msg);
        const m = msg.message?.model;
        if (actualModel === undefined && typeof m === "string" && m !== "") actualModel = m;
      }
      if (opts.onProgress !== undefined && isAssistantMessage(msg)) {
        turn += 1;
        for (const tool of toolNamesOf(msg)) {
          try {
            opts.onProgress({ kind: "tool_use", tool, turn });
          } catch {
            // 進捗表示側の失敗で検索を止めない(ADR-0035 D5)。
          }
        }
      }
    }
  } catch (cause) {
    if (abortedByCaller) {
      throw new LlmError("ABORTED", "Agent SDK query を中断しました", { cause });
    }
    if (abortController.signal.aborted) {
      throw new LlmError("TIMEOUT", `Agent SDK query が ${timeoutMs}ms でタイムアウトしました`, {
        cause,
      });
    }
    throw new LlmError("API_ERROR", "Agent SDK query が失敗しました", { cause });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
    // ADR-0042: spare は 1 回限り。claim の参照を外してから閉じる。
    warm?.close();
    // ADR-0042 D1: 次の 1 本を用意する。呼び出し側の中断(= bot の終了処理中)では用意しない。
    if (pre !== undefined && !abortedByCaller) {
      const p = pre;
      p.pool.replenish(specKey, () => spawnWarmSpare(p.prewarmFn, spec));
    }
  }

  // SDK が abort で例外を投げずに反復を終えた場合も、中断として扱う(部分的な result を採用しない)。
  if (abortedByCaller) {
    throw new LlmError("ABORTED", "Agent SDK query を中断しました");
  }
  if (!result) {
    throw new LlmError("API_ERROR", "Agent SDK から result メッセージが返りませんでした");
  }

  // usage は success / error どちらの result でも記録する(§7.3)。
  const usage: Usage = {
    inputTokens: result.usage?.input_tokens ?? 0,
    outputTokens: result.usage?.output_tokens ?? 0,
  };
  usageRecorder.record({ app: opts.app, role: opts.role, usage });
  // 観測用の使用量(1-1 計測)。input_tokens はキャッシュ分を含まないため、キャッシュ作成・読み取りを
  // 別に持つ。無い(旧 SDK・テスト用の差し替え)ならキー自体を持たない。
  const cacheCreationInputTokens = finiteOrUndefined(result.usage?.cache_creation_input_tokens);
  const cacheReadInputTokens = finiteOrUndefined(result.usage?.cache_read_input_tokens);
  const totalCostUsd = finiteOrUndefined(result.total_cost_usd);
  const modelUsage = sanitizeModelUsage(result.modelUsage);
  const extra = {
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(modelUsage !== undefined ? { modelUsage } : {}),
  };
  // 成否の判定より前に通知する(再試行される失敗回の費用も合算できるように)。
  try {
    opts.onUsage?.({ ...usage, ...extra });
  } catch {
    // 観測側の失敗で検索を止めない。
  }

  if (result.subtype !== "success") {
    const code: LlmErrorCode =
      result.subtype === "error_max_budget_usd"
        ? "BUDGET_EXCEEDED"
        : result.subtype === "error_max_structured_output_retries"
          ? "STRUCTURED_PARSE"
          : "API_ERROR";
    throw new LlmError(code, `Agent SDK が異常終了しました: ${result.subtype}`);
  }

  const parsed = opts.outputSchema.safeParse(result.structured_output);
  if (!parsed.success) {
    throw new LlmError(
      "STRUCTURED_PARSE",
      `structured_output が期待スキーマに一致しません: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  return {
    value: parsed.data,
    usage,
    ...extra,
    ...(typeof result.num_turns === "number" ? { numTurns: result.num_turns } : {}),
    ...(typeof result.duration_api_ms === "number"
      ? { durationApiMs: result.duration_api_ms }
      : {}),
    ...(Array.isArray(result.permission_denials)
      ? { deniedToolCalls: result.permission_denials.length }
      : {}),
    requestedModel,
    ...(actualModel !== undefined ? { actualModel } : {}),
    ...(startupMs !== undefined ? { startupMs } : {}),
    prewarmed,
    ...toolStats.stats(),
    ...(firstTurnCache?.read !== undefined ? { firstTurnCacheRead: firstTurnCache.read } : {}),
    ...(firstTurnCache?.creation !== undefined
      ? { firstTurnCacheCreation: firstTurnCache.creation }
      : {}),
  };
}
