/**
 * 環境変数の検証(design.md §9.1)。zod で必須・型を検証する。
 * シークレット(DISCORD_TOKEN / ANTHROPIC_API_KEY)はログに出さない。
 * テスト可能にするため source を注入できる(既定 process.env)。
 */
import { z } from "zod";

const envSchema = z.object({
  /** Discord Bot トークン(§9.1)。 */
  DISCORD_TOKEN: z.string().min(1),
  /** Anthropic API キー(§9.1)。Agent SDK が使用。 */
  ANTHROPIC_API_KEY: z.string().min(1),
  /** スラッシュコマンド登録先ギルド(任意。未指定はグローバル登録)。 */
  DISCORD_GUILD_ID: z.string().optional(),
  /** 検索対象リポの clone ルート(cwd)。 */
  CLONES_DIR: z.string().default("./.clones"),
  /** SQLite ファイルパス。 */
  DB_PATH: z.string().default("./data/bot.db"),
  /** members.yaml / channels.yaml の置き場。 */
  CONFIG_DIR: z.string().default("./config"),
});

export type Env = z.infer<typeof envSchema>;

/** process.env(または注入した source)を検証して返す。失敗時は zod エラーを throw。 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
