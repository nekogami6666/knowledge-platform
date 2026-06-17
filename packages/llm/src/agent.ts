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
 * ⚠️ セキュリティ境界の重要注意(敵対的レビュー所見 / 封じ込め方式は別途 ADR で確定予定):
 *   `cwd` は FS の封じ込め境界ではない。Read/Grep/Glob は cwd 外の絶対パス(~/.ssh, /proc/self/environ,
 *   兄弟 clone 等)も読め、その内容を structured_output(回答本文)に載せて漏洩させうる。§9.5 の
 *   「文書内に指示が混入しても実行能力がない」前提は、Read 自体が読み取り能力であるため完全には成立しない。
 *   本番ではプロセスを OS/コンテナの FS サンドボックス(可視範囲を clones に限定)で動かすことが必須
 *   (Phase 1b デプロイ要件)。Phase 1a は synthetic データのみのため影響は限定的。
 */
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LlmError, type LlmErrorCode } from "./errors.js";
import { type ModelRole, modelIdFor } from "./models.js";
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
}

export interface AgentSearchResult<T> {
  /** zod 検証済みの構造化出力。 */
  value: T;
  /** 入出力トークン(§7.3)。 */
  usage: Usage;
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

/** Agent SDK の終端 result メッセージ(必要部分のみ)。 */
interface ResultMessage {
  type: "result";
  subtype: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function isResultMessage(m: unknown): m is ResultMessage {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "result";
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

  // 封じ込めの主たる保証は permissionMode:"dontAsk"(未承認ツールはプロンプトせず拒否)+ allowedTools 許可リスト。
  // disallowedTools は冗長な明示拒否。mcpServers / agents / hooks / canUseTool / toolAliases /
  // additionalDirectories は能力を再導入しうるため意図的に未設定のまま維持する(§9.5)。
  const options: Options = {
    systemPrompt: opts.systemPrompt,
    model: modelIdFor(opts.role),
    cwd: opts.cwd,
    permissionMode: "dontAsk",
    settingSources: [],
    allowedTools: [...allowedTools],
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    outputFormat: { type: "json_schema", schema },
    maxTurns,
    abortController,
  };

  let result: ResultMessage | undefined;
  try {
    for await (const msg of queryFn({ prompt: opts.prompt, options })) {
      if (isResultMessage(msg)) result = msg;
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

  return { value: parsed.data, usage };
}
