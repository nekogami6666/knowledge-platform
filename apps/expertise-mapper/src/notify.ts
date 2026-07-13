/**
 * #stratum-ops への通知(design.md §6.6 ⑤-a step4)。risk:high のトピックを知らせて
 * インタビュー実施(C7)を提案する。webhook 未設定なら no-op。fetch は注入可能(テスト)。
 *
 * NOTE(重複回避): extractor/pr-miner の notify と同型だが文面が別。3 つ目の同型が既に現れているが、
 * 週次バッチごとに文面・payload が違うため当面は複製を維持(統合は packages/shared 検討時に一括)。
 */

/** risk:high トピックの通知 1 行分。 */
export interface RiskNotice {
  topic: string;
  label: string;
  /** evidence 最上位の人(バス係数 1 の「その人」)。 */
  top: string;
}

export interface Notifier {
  notifyHighRisk(items: readonly RiskNotice[], reportPath: string): Promise<void>;
}

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export function createWebhookNotifier(webhookUrl: string | undefined, fetchFn?: FetchFn): Notifier {
  return {
    async notifyHighRisk(items, reportPath) {
      if (webhookUrl === undefined || webhookUrl.length === 0) return; // 未設定 → no-op
      if (items.length === 0) return; // high 無し → 通知しない(通知疲れ防止)
      const f = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
      const lines = items.map((i) => `- **${i.label}**(${i.topic})— 依存: ${i.top}`);
      const content = [
        `🗺️ 専門性マップを更新しました。**risk: high** のトピックがあります(バス係数 1 かつ文書化僅少):`,
        ...lines,
        `詳細: knowledge-base の ${reportPath}`,
        "インタビュー(⑤-b)の実施を検討してください。",
      ].join("\n");
      await f(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    },
  };
}
