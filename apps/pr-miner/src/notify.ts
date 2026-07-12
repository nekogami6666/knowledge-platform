/**
 * #stratum-ops への通知(design.md §6.4 ③-c)。webhook に POST(cron に Gateway 接続は不要・
 * extractor/notify.ts と同形のアプリ内コピー)。webhook 未設定なら no-op。fetch は注入可能(テスト)。
 * PR URL さえ本文に含めれば bot の代理マージ(discord.ts の handleProxyMergeReaction)が機能する。
 *
 * NOTE(重複回避): extractor/notify.ts と実装は同型だが文面が別(「PR マイニング」)。3 つ目の通知者が
 * 現れたら packages/shared 等へ統合する(週次バッチごとに文面を変えたいので当面は複製)。
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
  /** マイニング対象になった PR 数 / リポ数(サマリ)。 */
  minedPrs: number;
  repos: number;
  counts: NotifyCounts;
}

export interface Notifier {
  notifyPrCreated(msg: NotifyMessage): Promise<void>;
}

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
        `🔎 週次 PR マイニングの提案 PR を作成しました: ${msg.prUrl}`,
        `対象: ${msg.repos} リポ / ${msg.minedPrs} PR`,
        `新規 ${c.new} / 追記 ${c.append} / 矛盾 ${c.supersede} / skip ${c.skip}`,
        "問題なければ 👍(bot が代理マージ)、修正は PR で直接編集してください。",
      ].join("\n");
      await f(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    },
  };
}
