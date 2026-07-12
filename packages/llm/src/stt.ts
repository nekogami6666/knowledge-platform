/**
 * 音声文字起こし(STT)クライアント(design.md §6.4 ③-b / ADR-0015)。
 * 既存議事録パイプライン(QB-Meeting-Ops)とエンジン = OpenAI transcription API を共有し、
 * プロセスは共有しない(ADR-0015 D1)。OpenAI への依存は本パッケージ内のみに閉じる
 * (`@anthropic-ai/*` と同じ封じ込め・D2)。テキスト生成は従来どおり Claude(runAgentSearch)のみで、
 * OpenAI に送るのは音声バイナリと文字起こしパラメータだけ。
 * STT は秒課金でトークン型 Usage(usage.ts)に載らないため UsageRecorder は使わず、
 * 呼び出し側が結果(model)をログに残す。
 * API キーは引数注入 — Agent SDK subprocess の env allowlist に OPENAI_ は追加しない(D3)。
 */
import { LlmError } from "./errors.js";
import { STT_MODEL } from "./models.js";
import { type RetryOptions, withRetry } from "./retry.js";

export interface TranscribeInput {
  /** 音声バイナリ。 */
  audio: Uint8Array;
  /** 元ファイル名(API が拡張子で形式を判定する。例 "memo.ogg")。 */
  filename: string;
  /** MIME タイプ(不明なら省略)。 */
  contentType?: string;
  /** 言語ヒント(ISO-639-1)。既定 "ja"(§7.5 日本語運用)。 */
  language?: string;
}

export interface TranscribeResult {
  /** 文字起こし全文。呼び出し側が無加工で原本保存する(P1)。 */
  text: string;
  /** 使用モデル(ログ用)。 */
  model: string;
}

/** STT の注入 seam(テストは固定テキストを返す fake を渡す)。 */
export type Transcriber = (input: TranscribeInput) => Promise<TranscribeResult>;

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface OpenAiTranscriberOptions {
  /** OpenAI API キー(env の読み込みは呼び出し側。ログに出さない・§9.1)。 */
  apiKey: string;
  /** 既定 STT_MODEL(models.ts で一元管理。直書き禁止)。 */
  model?: string;
  /** 既定 https://api.openai.com/v1(テスト・将来のプロキシ用)。 */
  baseUrl?: string;
  /** fetch 実装(テストで差し替え)。 */
  fetchFn?: typeof fetch;
  /** リトライ設定(§7.1。既定は withRetry の既定 = 最大 3 回)。 */
  retry?: RetryOptions;
  /** 1 リクエストのタイムアウト(ms)。既定 120000。 */
  timeoutMs?: number;
}

/**
 * OpenAI transcription API(POST /audio/transcriptions・multipart)を呼ぶ Transcriber を作る。
 * 429 / 5xx / タイムアウトは LlmError(リトライ対象 code)に写像して withRetry に委ねる(§7.1)。
 */
export function createOpenAiTranscriber(options: OpenAiTranscriberOptions): Transcriber {
  const model = options.model ?? STT_MODEL;
  const baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (input) => {
    const attempt = async (): Promise<TranscribeResult> => {
      const form = new FormData();
      const blob =
        input.contentType === undefined
          ? new Blob([input.audio])
          : new Blob([input.audio], { type: input.contentType });
      form.append("file", blob, input.filename);
      form.append("model", model);
      form.append("language", input.language ?? "ja");
      form.append("response_format", "json");

      let res: Response;
      try {
        res = await fetchFn(`${baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // AbortSignal.timeout は name="TimeoutError" の DOMException を投げる。
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new LlmError("TIMEOUT", `STT がタイムアウトしました(${timeoutMs}ms)`, {
            cause: err,
          });
        }
        throw new LlmError("API_ERROR", "STT のネットワークエラー", { cause: err });
      }

      if (!res.ok) {
        // エラー詳細は先頭だけ(応答が巨大でもログを汚さない)。
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        if (res.status === 429) {
          throw new LlmError("RATE_LIMITED", `STT 429: ${detail}`);
        }
        if (res.status >= 500) {
          throw new LlmError("OVERLOADED", `STT ${res.status}: ${detail}`);
        }
        throw new LlmError("API_ERROR", `STT ${res.status}: ${detail}`);
      }

      const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
      if (data === null || typeof data.text !== "string") {
        throw new LlmError("STRUCTURED_PARSE", "STT 応答に text がありません");
      }
      return { text: data.text, model };
    };
    return withRetry(attempt, options.retry);
  };
}
