/**
 * 単発 Anthropic Messages API ラッパ(design.md §5.1「LLM(単発タスク)」/ §7.1〜7.3)。
 * 本ファイルは `@anthropic-ai/sdk` を import する唯一の場所(CLAUDE.md §12.2)。
 * agentic search ではない構造化 1 ショット呼び出し。golden eval の LLM-as-judge(§10.2(b))が
 * 最初の利用者で、Phase 2 の extractor(role "standard")も再利用する L2 プリミティブ。
 *
 * runAgentSearch(agent.ts)の制御フローを踏襲:
 * - 注入 transport seam(既定=実 SDK)。ユニットテストはここを差し替えてキー/ネットワーク不要に
 * - structured output は output_config.format(json_schema、zod-to-json-schema で生成)で強制し、
 *   受領後に zod で再検証(belt-and-suspenders)。zodOutputFormat ヘルパは zod v4 前提のため不使用
 * - LlmError へマッピング(既存コードのみ再利用)。usage は応答取得時に記録(§7.3)
 * - new Anthropic({ maxRetries: 0 }):SDK 自動リトライを無効化し、§7.1 リトライは呼び出し側 withRetry が所有
 *
 * agent.ts との明示的な差異:
 * - タイムアウトは AbortController ではなく SDK の per-request `{ timeout }`(単発の SDK 正道)
 * - usage は「応答取得時のみ」記録。messages.parse は transport エラーで usage を持たず throw するため
 *   (runAgentSearch は usage 付き terminal result を受け取るので success/error 双方で記録できた)
 */
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LlmError } from "./errors.js";
import { type ModelRole, modelIdFor } from "./models.js";
import { nullUsageRecorder, type Usage, type UsageRecorder } from "./usage.js";

export interface GenerateStructuredOptions<T> {
  /** UsageRecorder のラベル(アプリ名、§7.3)。 */
  app: string;
  /** モデルロール(§5.2)。modelIdFor で解決(モデル ID 直書き禁止)。 */
  role: ModelRole;
  /** 信頼できる system 本文(loadPrompt().body)。被評価データは入れない。 */
  systemPrompt: string;
  /** 単一ユーザターン本文(judge は §9.5 の DATA ブロックを渡す)。 */
  userContent: string;
  /** 構造化出力の zod スキーマ。json_schema に変換して渡し、戻り値を再検証する。 */
  outputSchema: z.ZodType<T>;
  /** 最大トークン。既定 1024(verdict は小さい)。 */
  maxTokens?: number;
  /** output_config.effort。既定は省略(=high)。 */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** adaptive thinking を有効化。既定 true(opus-4-8)。false で thinking を省略。 */
  thinking?: boolean;
  /** タイムアウト(ms)。既定 60000。SDK の per-request { timeout } で実装。 */
  timeoutMs?: number;
}

export interface GenerateStructuredResult<T> {
  value: T;
  usage: Usage;
}

/** 注入 transport が返す最小契約(消費する形だけ narrow に型付け)。 */
export interface ParseResponse {
  /** 抽出失敗 / refusal / max_tokens 時は null。 */
  parsed_output: unknown;
  usage: { input_tokens: number; output_tokens: number } | null;
}

/** Messages transport の差し替え可能 seam。params は緩く型付けし、mock が SDK 型を再構築せずに済む。 */
export type MessagesParseFn = (
  params: Record<string, unknown>,
  options: { timeout: number },
) => Promise<ParseResponse>;

export interface GenerateDeps {
  /** Messages transport の差し替え(テスト用)。既定は実 SDK(messages.create)。 */
  parseFn?: MessagesParseFn;
  /** usage 記録先。既定 no-op。 */
  usage?: UsageRecorder;
}

/**
 * SDK Message から構造化出力(JSON)を抽出する純関数。text ブロックのみを連結して JSON.parse する
 * (thinking ブロックは無視)。空 / refusal / max_tokens 切り詰め等で JSON 化できなければ
 * parsed_output=null(呼び出し側が STRUCTURED_PARSE に倒す)。seam の外でテスト可能にするため export。
 */
export function parseMessageResponse(msg: {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number } | null;
}): ParseResponse {
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  let parsed_output: unknown = null;
  try {
    parsed_output = JSON.parse(text);
  } catch {
    parsed_output = null;
  }
  return { parsed_output, usage: msg.usage };
}

/**
 * 既定 transport(実 SDK)。seam の背後に隔離され、ユニットテストでは実行されない。
 * output_config.format(json_schema)で JSON を強制し、{@link parseMessageResponse} で抽出する
 * (agent.ts と同じく手動検証。SDK の zodOutputFormat ヘルパは zod v4 型前提で本リポの zod v3 と
 * 不整合のため使わない)。
 */
const defaultParseFn: MessagesParseFn = async (params, options) => {
  // maxRetries:0 で SDK 自動リトライを無効化(§7.1 は withRetry が所有)。キーは process.env から。
  const client = new Anthropic({ maxRetries: 0 });
  const msg = (await client.messages.create(params as never, options)) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  return parseMessageResponse(msg);
};

/** SDK 例外を LlmError(既存コードのみ)へマッピング。 */
function mapError(cause: unknown, timeoutMs: number): LlmError {
  if (cause instanceof Anthropic.RateLimitError) {
    return new LlmError("RATE_LIMITED", "Anthropic API レート制限(429)", { cause });
  }
  if (cause instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError("TIMEOUT", `Anthropic API がタイムアウトしました(${timeoutMs}ms)`, {
      cause,
    });
  }
  if (cause instanceof Anthropic.APIError) {
    // 0.104.2 は OverloadedError を export しないため 529 は status で判定。
    if (cause.status === 529) {
      return new LlmError("OVERLOADED", "Anthropic API 過負荷(529)", { cause });
    }
    if (cause.status === 408) {
      return new LlmError("TIMEOUT", `Anthropic API がタイムアウトしました(${timeoutMs}ms)`, {
        cause,
      });
    }
    return new LlmError("API_ERROR", `Anthropic API エラー(status=${cause.status ?? "?"})`, {
      cause,
    });
  }
  return new LlmError("API_ERROR", "Anthropic Messages 呼び出しが失敗しました", { cause });
}

/**
 * 単発の構造化出力を得る。structured output を zod で再検証して返す。usage は記録する(§7.3)。
 * 429/529/timeout は RETRYABLE_LLM_CODES の LlmError になるため、呼び出し側 withRetry が §7.1 リトライ。
 */
export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>,
  deps: GenerateDeps = {},
): Promise<GenerateStructuredResult<T>> {
  const parseFn = deps.parseFn ?? defaultParseFn;
  const usageRecorder = deps.usage ?? nullUsageRecorder;
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const thinking = opts.thinking ?? true;

  const params: Record<string, unknown> = {
    model: modelIdFor(opts.role),
    max_tokens: maxTokens,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userContent }],
    output_config: {
      // $refStrategy:"none" で root を素の object schema にする(agent.ts と同方針)。
      format: {
        type: "json_schema",
        schema: zodToJsonSchema(opts.outputSchema, { $refStrategy: "none" }) as Record<
          string,
          unknown
        >,
      },
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
    // budget_tokens / temperature / top_p は opus-4-8 で 400 になるため決して入れない。
    ...(thinking ? { thinking: { type: "adaptive" } } : {}),
  };

  let response: ParseResponse;
  try {
    response = await parseFn(params, { timeout: timeoutMs });
  } catch (cause) {
    throw mapError(cause, timeoutMs);
  }

  // usage は parsed_output の null チェックより前に記録(切り詰め応答でも計上、§7.3)。
  const usage: Usage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
  usageRecorder.record({ app: opts.app, role: opts.role, usage });

  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new LlmError(
      "STRUCTURED_PARSE",
      "応答から構造化出力(JSON)を取得できませんでした(refusal / max_tokens / parse 失敗)",
    );
  }

  const parsed = opts.outputSchema.safeParse(response.parsed_output);
  if (!parsed.success) {
    throw new LlmError(
      "STRUCTURED_PARSE",
      `parsed_output が期待スキーマに一致しません: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  return { value: parsed.data, usage };
}
