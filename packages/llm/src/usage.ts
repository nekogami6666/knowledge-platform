/**
 * トークン使用量の記録(design.md §7.3)。
 * 注: 正式な請求額ではなく、Bot 運用上の概算 usage / コスト追跡を目的とする。
 * 記録先はアプリ別(discord-bot は SQLite、バッチは Actions ログ)に注入する。
 */
import type { ModelRole } from "./models.js";

/** 1 回の LLM 呼び出しの入出力トークン。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** 使用量の記録先。注入で差し替え、テスト可能にする。 */
export interface UsageRecorder {
  record(entry: { app: string; role: ModelRole; usage: Usage }): void;
}

/** 何もしない既定レコーダ(記録不要・テスト用)。 */
export const nullUsageRecorder: UsageRecorder = {
  record() {},
};
