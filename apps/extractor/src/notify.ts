/**
 * #stratum-ops への通知(design.md §6.3 step5)。webhook に POST(cron に Gateway 接続は不要・weekly-eval と同形)。
 * webhook 未設定なら no-op。fetch は注入可能(テスト)。
 * 通知は best-effort(失敗しても run は落とさない)が、無音の握りつぶしは経路故障に気づけないため
 * 必ず warn を残す(2026-07-26 の webhook 誤設定が 2 日間無検知だった反省)。
 */
import type { Logger } from "./logger.js";

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
  /**
   * 未マージの抽出 PR があるため今回の run を見送ったことを知らせる(冪等ガード)。
   * 通知しないと「毎晩静かに skip」が続き、レビュー滞留に誰も気づけない。
   */
  notifySkipped(msg: { prUrl: string }): Promise<void>;
}

/** 使用する fetch の最小契約(実 fetch を構造的に満たす)。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export function createWebhookNotifier(
  webhookUrl: string | undefined,
  fetchFn?: FetchFn,
  logger?: Logger,
): Notifier {
  async function post(content: string): Promise<void> {
    if (webhookUrl === undefined || webhookUrl.length === 0) return; // 未設定 → no-op
    const f = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
    let res: { ok: boolean; status: number };
    try {
      res = await f(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } catch (err) {
      logger?.warn("通知の投稿に失敗", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!res.ok) {
      logger?.warn("通知の投稿に失敗", { status: res.status });
    }
  }

  return {
    async notifyPrCreated(msg) {
      const c = msg.counts;
      await post(
        [
          `📥 抽出 PR を作成しました: ${msg.prUrl}`,
          `新規 ${c.new} / 追記 ${c.append} / 矛盾 ${c.supersede} / skip ${c.skip} / 未解決の問い ${c.openQuestions}`,
          msg.people.length > 0 ? `関係者: ${msg.people.join(", ")}` : "",
          "問題なければ 👍(bot が代理マージ)、修正は PR で直接編集してください。",
        ]
          .filter((l) => l.length > 0)
          .join("\n"),
      );
    },
    async notifySkipped(msg) {
      await post(
        [
          "⏸ 未マージの抽出 PR があるため、今回の抽出を見送りました。",
          msg.prUrl,
          "この PR をマージ(またはクローズ)すると次回から再開します。",
        ].join("\n"),
      );
    },
  };
}
