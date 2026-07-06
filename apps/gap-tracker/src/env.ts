/**
 * gap-tracker の環境変数検証(design.md §6.5 / §9.1 / ADR-0014)。
 * bot と同じ VM で動く systemd timer(ADR-0014 D1)。LLM は使わない(依頼文は決定論テンプレ。
 * 回答のナレッジ化=LLM は PR-D3 で追加)。
 * シークレット(GITHUB_TOKEN / GITHUB_APP_PRIVATE_KEY / DISCORD_GAP_WEBHOOK)はログに出さない。
 */
import { z } from "zod";

const envSchema = z.object({
  /** bot の SQLite(未回答キュー)。ADR-0014 D2: 同一 VM のファイルを直接読む。 */
  DB_PATH: z.string().min(1),
  /** 回答依頼を投稿する Discord webhook(§6.5 step3)。 */
  DISCORD_GAP_WEBHOOK: z.string().min(1),
  // GitHub 認証(gh-client。App trio か token・ADR-0011)。実 commit(GAP_TRACKER_REAL)時のみ必須。
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  /** "1"/"true" で実 commit + 実依頼送信。既定は dry-run(計画をログするだけ)。 */
  GAP_TRACKER_REAL: z.string().optional(),
  CLONES_DIR: z.string().default("./.clones"),
  CONFIG_DIR: z.string().default("./config"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

/** 実 commit / 実依頼を行ってよいか(既定 false=dry-run)。 */
export function isReal(env: Env): boolean {
  return env.GAP_TRACKER_REAL === "1" || env.GAP_TRACKER_REAL === "true";
}
