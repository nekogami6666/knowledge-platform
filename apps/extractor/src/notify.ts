/**
 * #stratum-ops への通知(design.md §6.3 step5)。webhook に POST(cron に Gateway 接続は不要・weekly-eval と同形)。
 * webhook 未設定なら no-op。fetch は注入可能(テスト)。
 */
export interface NotifyCounts {
  new: number;
  append: number;
  supersede: number;
  skip: number;
  openQuestions: number;
}

export interface NotifyMessage {
  prUrl: string;
  counts: NotifyCounts;
  people: readonly string[];
}

export interface Notifier {
  notifyPrCreated(msg: NotifyMessage): Promise<void>;
}

/** 使用する fetch の最小契約(実 fetch を構造的に満たす)。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export function createWebhookNotifier(webhookUrl: string | undefined, fetchFn?: FetchFn): Notifier {
  return {
    async notifyPrCreated(msg) {
      if (webhookUrl === undefined || webhookUrl.length === 0) return; // 未設定 → no-op
      const f = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
      const c = msg.counts;
      const content = [
        `📥 抽出 PR を作成しました: ${msg.prUrl}`,
        `新規 ${c.new} / 追記 ${c.append} / 矛盾 ${c.supersede} / skip ${c.skip} / 未解決の問い ${c.openQuestions}`,
        msg.people.length > 0 ? `関係者: ${msg.people.join(", ")}` : "",
        "問題なければ 👍(将来 bot が代理マージ)、修正は PR で直接編集してください。",
      ]
        .filter((l) => l.length > 0)
        .join("\n");
      await f(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    },
  };
}
