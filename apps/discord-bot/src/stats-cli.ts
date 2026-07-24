/**
 * 週次利用レポート CLI(design.md §1.4 KPI / §7.3「週次サマリを #stratum-ops へ」)。
 * bot と同じ VM の systemd timer(stratum-stats.timer・月 09:00 JST)から起動される。
 * bot.db を read-only で集計し、DISCORD_OPS_WEBHOOK へ投稿する。webhook 未設定なら投稿せずログのみ
 * (= dry-run 相当)。bot.db に触るバッチは GitHub Actions 不可・VM timer 必須(§4.6 / ADR-0016 D4)。
 *
 * bot 本体には webhook 配線を足さない(bot の外向き I/O は Gateway 限定を維持)。投稿はこの CLI だけが行う。
 */
import { z } from "zod";
import { createLogger } from "./logger.js";
import { createSqliteStore } from "./sqlite-store.js";
import { runStatsReport } from "./stats.js";

const envSchema = z.object({
  DB_PATH: z.string().default("./data/bot.db"),
  DISCORD_OPS_WEBHOOK: z.string().optional(),
});

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  // webhook URL は秘密(知っていれば投稿できる・§9.1)。ログから値をスクラブする。
  const logger = createLogger(
    "info",
    undefined,
    env.DISCORD_OPS_WEBHOOK !== undefined ? [env.DISCORD_OPS_WEBHOOK] : [],
  );
  const store = createSqliteStore(env.DB_PATH);

  const post = async (content: string): Promise<void> => {
    const url = env.DISCORD_OPS_WEBHOOK;
    if (url === undefined || url.length === 0) {
      logger.warn(
        { preview: content.slice(0, 80) },
        "DISCORD_OPS_WEBHOOK 未設定のため投稿しません(集計はログのみ)",
      );
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "週次レポートの投稿に失敗");
  };

  try {
    await runStatsReport({ store, now: () => new Date(), post, logger });
  } finally {
    store.close();
  }
}

main().catch((err) => {
  createLogger().error({ err }, "stats-cli failed");
  process.exitCode = 1;
});
