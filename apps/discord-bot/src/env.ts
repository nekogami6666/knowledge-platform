/**
 * 環境変数の検証(design.md §9.1 / ADR-0008)。zod で必須・型を検証する。
 * シークレット(DISCORD_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_AWS_API_KEY)はログに出さない。
 * テスト可能にするため source を注入できる(既定 process.env)。
 */
import { z } from "zod";

const envSchema = z
  .object({
    /** Discord Bot トークン(§9.1)。 */
    DISCORD_TOKEN: z.string().min(1),
    /** Anthropic API キー(§9.1)。第一者 API 利用時に必須。Claude Platform on AWS 利用時は不要(ADR-0008)。 */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** Claude Platform on AWS(Claude Code on AWS)を使う(ADR-0008)。"1"/"true" で有効。 */
    CLAUDE_CODE_USE_ANTHROPIC_AWS: z.string().optional(),
    /** Claude Platform on AWS のワークスペース API キー(§9.1)。ログに出さない。 */
    ANTHROPIC_AWS_API_KEY: z.string().optional(),
    /** Claude Platform on AWS のワークスペース ID。 */
    ANTHROPIC_AWS_WORKSPACE_ID: z.string().optional(),
    /** Claude Platform on AWS のリージョン(ADR-0008)。 */
    AWS_REGION: z.string().optional(),
    /** スラッシュコマンド登録先ギルド(任意。未指定はグローバル登録)。 */
    DISCORD_GUILD_ID: z.string().optional(),
    /** 検索対象リポの clone ルート(cwd)。 */
    CLONES_DIR: z.string().default("./.clones"),
    /** SQLite ファイルパス。 */
    DB_PATH: z.string().default("./data/bot.db"),
    /** members.yaml / channels.yaml / repos.yaml の置き場。 */
    CONFIG_DIR: z.string().default("./config"),
    /** プロンプト(prompts/<app>/<name>.md)のルート。リポジトリルートの prompts/。 */
    PROMPTS_DIR: z.string().default("./prompts"),
  })
  .superRefine((env, ctx) => {
    const platformAws =
      env.CLAUDE_CODE_USE_ANTHROPIC_AWS === "1" || env.CLAUDE_CODE_USE_ANTHROPIC_AWS === "true";
    // 第一者 API では ANTHROPIC_API_KEY 必須。Claude Platform on AWS では AWS 認証(ワークスペースキー)に委ねる。
    if (!platformAws && (env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message:
          "ANTHROPIC_API_KEY が必要です(Claude Platform on AWS を使う場合は CLAUDE_CODE_USE_ANTHROPIC_AWS=1)",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** process.env(または注入した source)を検証して返す。失敗時は zod エラーを throw。 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
