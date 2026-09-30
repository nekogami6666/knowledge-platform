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
 */
import {
  type HookCallback,
  type Options,
  query,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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

export interface AgentSearchOptions<T> {
  /** UsageRecorder のラベル(アプリ名)。 */
  app: string;
  /** モデルロール(§5.2)。モデル ID は models.ts から解決する。 */
  role: ModelRole;
  /** system prompt 本文(loadPrompt で読んだ body)。 */
  systemPrompt: string;
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
  /** 努力度(未指定なら SDK 既定)。所要時間と回答品質のトレードオフ調整用(ADR-0035 D6)。 */
  effort?: AgentEffort;
  /** 拡張思考(未指定なら SDK 既定)。 */
  thinking?: AgentThinking;
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
}

const defaultQueryFn: AgentQueryFn = (params) => query(params);

/** 公開型 AgentThinking → SDK ThinkingConfig。 */
function thinkingConfigOf(t: AgentThinking): ThinkingConfig {
  return t === "disabled" ? { type: "disabled" } : { type: "adaptive" };
}

/** Agent SDK の終端 result メッセージ(必要部分のみ)。 */
interface ResultMessage {
  type: "result";
  subtype: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  num_turns?: number;
  duration_api_ms?: number;
  permission_denials?: unknown[];
}

/** Agent SDK の assistant メッセージ(tool_use ブロック抽出に必要な部分のみ)。 */
interface AssistantMessage {
  type: "assistant";
  message?: { content?: unknown; model?: unknown };
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

function isResultMessage(m: unknown): m is ResultMessage {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "result";
}

/**
 * 読み取り封じ込めの PreToolUse hook を作る(ADR-0037)。root = realpath(cwd) を生成時に 1 回だけ解決し、
 * ファイル系ツールの対象 realpath が root 外なら deny を返す。**allow は決して返さない**(判定を
 * permission 系へ委ねる `{}` か deny のみ)ため、hook が能力を再導入することはない。
 * 判定中の想定外例外はファイル系ツールに限り deny に倒す(fail-closed)。
 */
export function createContainmentHook(cwd: string, realpath?: RealpathFn): HookCallback {
  const root = resolveContainmentRoot(cwd, realpath);
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    let reason: string | undefined;
    try {
      const d = checkToolPathContainment(input.tool_name, input.tool_input, root, realpath);
      if (!d.allowed) reason = d.reason;
    } catch {
      reason = `${input.tool_name}: パス判定に失敗したため拒否しました`;
    }
    if (reason === undefined) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

/**
 * 質問に対して agentic search を実行し、構造化出力を zod 検証して返す。
 * 許可ツールは Read/Grep/Glob のみ、設定は読み込まない(§9.5)。usage は常に記録する。
 */
export async function runAgentSearch<T>(
  opts: AgentSearchOptions<T>,
  deps: LlmDeps = {},
): Promise<AgentSearchResult<T>> {
  const queryFn = deps.queryFn ?? defaultQueryFn;
  const usageRecorder = deps.usage ?? nullUsageRecorder;
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const maxTurns = opts.maxTurns ?? 30;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // $refStrategy:"none" で $ref ラップを避け、root を素の type:"object" schema にする。
  const schema = zodToJsonSchema(opts.outputSchema, { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  // ツール能力の封じ込め: permissionMode:"dontAsk"(未承認ツールはプロンプトせず拒否)+ allowedTools 許可リスト
  // + tools で基本ツール集合自体を allowedTools に絞る(allowedTools:[] でも既定では cwd 配下の Read/Grep/Glob が
  // 通るため・ADR-0037 実験)。disallowedTools は冗長な明示拒否。
  // 読み取り範囲の封じ込め(ADR-0037): deny のみを返す PreToolUse hook + SDK の
  // blockReadsOutsideWorkingDirectories。mcpServers / agents / canUseTool / toolAliases / additionalDirectories は
  // 能力・到達範囲を広げうるため意図的に未設定のまま維持する(§9.5)。
  const requestedModel = modelIdFor(opts.role);
  const options: Options = {
    systemPrompt: opts.systemPrompt,
    model: requestedModel,
    cwd: opts.cwd,
    permissionMode: "dontAsk",
    settingSources: [],
    // 会話記録(検索で読んだ社内文書の本文を含む)を ~/.claude/projects に残さない(2026-10-01)。
    persistSession: false,
    tools: [...allowedTools],
    allowedTools: [...allowedTools],
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    // flag 設定層(settingSources:[] でも適用される)。managedSettings は IT 管理設定がある環境で
    // 既定で捨てられるため使わない(ADR-0037)。
    settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
    hooks: { PreToolUse: [{ hooks: [createContainmentHook(opts.cwd)] }] },
    // §9.1 / ADR-0006: subprocess env を最小許可リストに置換し、DISCORD_TOKEN 等を渡さない。
    env: buildAgentEnv(),
    outputFormat: { type: "json_schema", schema },
    maxTurns,
    abortController,
    // ADR-0035 D6: 実験ノブ。未指定時はキー自体を渡さず SDK 既定に委ねる(挙動不変)。
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.thinking !== undefined ? { thinking: thinkingConfigOf(opts.thinking) } : {}),
  };

  let result: ResultMessage | undefined;
  let turn = 0;
  let actualModel: string | undefined;
  try {
    for await (const msg of queryFn({ prompt: opts.prompt, options })) {
      if (isResultMessage(msg)) result = msg;
      else if (isAssistantMessage(msg) && actualModel === undefined) {
        const m = msg.message?.model;
        if (typeof m === "string" && m !== "") actualModel = m;
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
    if (abortController.signal.aborted) {
      throw new LlmError("TIMEOUT", `Agent SDK query が ${timeoutMs}ms でタイムアウトしました`, {
        cause,
      });
    }
    throw new LlmError("API_ERROR", "Agent SDK query が失敗しました", { cause });
  } finally {
    clearTimeout(timer);
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
    ...(typeof result.num_turns === "number" ? { numTurns: result.num_turns } : {}),
    ...(typeof result.duration_api_ms === "number"
      ? { durationApiMs: result.duration_api_ms }
      : {}),
    ...(Array.isArray(result.permission_denials)
      ? { deniedToolCalls: result.permission_denials.length }
      : {}),
    requestedModel,
    ...(actualModel !== undefined ? { actualModel } : {}),
  };
}
