/**
 * freshness-checker の環境変数検証(design.md §6.7 / §9.1 / ADR-0019)。
 * bot と同じ VM で動く systemd timer(ADR-0019 D1。pending_actions を bot.db に積むため)。
 * LLM は使わない(期限判定は決定論)ので AWS/Claude env は不要。
 * シークレット(GITHUB_TOKEN / GITHUB_APP_PRIVATE_KEY / DISCORD_OPS_WEBHOOK)はログに出さない。
 */
import { z } from "zod";

const envSchema = z.object({
  /** bot の SQLite(pending_actions / rate_limits)。ADR-0014 D2: 同一 VM のファイルを直接読む。 */
  DB_PATH: z.string().min(1),
  /** stale 降格の報告先 #stratum-ops webhook。任意。 */
  DISCORD_OPS_WEBHOOK: z.string().optional(),
  // GitHub 認証(gh-client。App trio か token・ADR-0011)。実 commit(FRESHNESS_REAL)時のみ必須。
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  /** "1"/"true" でキュー投入 + stale 降格 commit を実行。既定は dry-run(計画をログするだけ)。 */
  FRESHNESS_REAL: z.string().optional(),
  CLONES_DIR: z.string().default("./.clones"),
  CONFIG_DIR: z.string().default("./config"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

/** 実キュー投入 / 実 commit を行ってよいか(既定 false=dry-run)。 */
export function isReal(env: Env): boolean {
  return env.FRESHNESS_REAL === "1" || env.FRESHNESS_REAL === "true";
}
