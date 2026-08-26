/**
 * 会話ウィンドウ 1 つ → 抽出候補(ADR-0033 D2)。extract.ts(議事録)と同じ規律:
 * ツール無し単発(`allowedTools: []`)で本文を prompt にインライン、schema は
 * extractionResultSchema を fork しない(§9.5: LLM に出典を出させない)。
 * プロンプトは prompts/extractor/extract-discord.md(role: standard)。
 */
import {
  loadPrompt,
  nullUsageRecorder,
  retryableExceptTimeout,
  runAgentSearch,
  type Usage,
  withRetry,
} from "@stratum/llm";
import { type ExtractionResult, extractionResultSchema } from "../candidate.js";
import type { ExtractDeps, ExtractSearchFn } from "../extract.js";
import type { WindowMessage } from "./window.js";

/** 1 メッセージの本文をプロンプトへ載せる上限(pr-miner の切詰め定数と同じくコード内・D7)。 */
const MAX_MESSAGE_CHARS = 1_000;

/** JST の "YYYY-MM-DD HH:mm" 表示(ウィンドウの期間レンジ用)。 */
function jstStamp(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * ウィンドウ → user prompt。著者ラベルは**呼び出し側で正規化済み**(ADR-0033 D8:
 * githubForDiscord ?? nameForDiscord ?? 表示名)の前提。lines 引用は意味を持たないため
 * 行番号は振らない(candidate.lines は任意フィールド)。
 */
export function buildDiscordExtractPrompt(
  window: readonly WindowMessage[],
  existingDomains: readonly string[],
): string {
  const first = window[0];
  const last = window[window.length - 1];
  const range =
    first !== undefined && last !== undefined
      ? `${jstStamp(first.createdAt)} 〜 ${jstStamp(last.createdAt)}(JST)`
      : "";
  const lines = window.map((m) => {
    const body =
      m.content.length > MAX_MESSAGE_CHARS
        ? `${m.content.slice(0, MAX_MESSAGE_CHARS)}…`
        : m.content;
    return `[${m.authorName}] ${body.replaceAll("\n", "\n  ")}`;
  });
  const domains =
    existingDomains.length > 0
      ? `既存 domain(なるべくここから選ぶ・無ければ新設): ${[...existingDomains].sort().join(", ")}`
      : "";
  return [
    `以下は社内 Discord チャンネルの会話です(期間: ${range})。`,
    domains,
    "--- 会話ここから ---",
    ...lines,
    "--- 会話ここまで ---",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

/** ウィンドウ 1 つを抽出する(extract.ts の extractFromMinutes と同じ seam・deps 形)。 */
export async function extractFromWindow(
  input: { window: readonly WindowMessage[]; cwd: string },
  deps: ExtractDeps,
): Promise<{ value: ExtractionResult; usage: Usage }> {
  const usage = deps.usage ?? nullUsageRecorder;
  const prompt = await loadPrompt("extractor", "extract-discord", deps.promptStore);
  const userPrompt = buildDiscordExtractPrompt(input.window, deps.existingDomains ?? []);
  const doSearch: ExtractSearchFn = deps.search ?? runAgentSearch;
  const res = await withRetry(
    () =>
      doSearch(
        {
          app: "extractor-discord",
          role: prompt.role,
          systemPrompt: prompt.body,
          prompt: userPrompt,
          cwd: input.cwd,
          outputSchema: extractionResultSchema,
          allowedTools: [],
          timeoutMs: deps.timeoutMs ?? 300_000,
        },
        { usage },
      ),
    { maxRetries: 1, shouldRetry: retryableExceptTimeout, ...deps.retry },
  );
  return { value: res.value, usage: res.usage };
}
