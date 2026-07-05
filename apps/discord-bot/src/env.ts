/**
 * 環境変数の検証(design.md §9.1 / ADR-0008 / ADR-0009)。zod で必須・型を検証する。
 * 全 AI 操作は Claude on AWS(Agent SDK)経由に統一(ADR-0009)。第一者 API キー(ANTHROPIC_API_KEY)は
 * 撤去し、Claude on AWS の env を必須にする。
 * シークレット(DISCORD_TOKEN / ANTHROPIC_AWS_API_KEY)はログに出さない(§9.1)。
 * テスト可能にするため source を注入できる(既定 process.env)。
 */
import { z } from "zod";

const envSchema = z
  .object({
    /** Discord Bot トークン(§9.1)。 */
    DISCORD_TOKEN: z.string().min(1),
    /** Claude on AWS(Claude Code on AWS)を使う(ADR-0009)。"1"/"true" 必須。 */
    CLAUDE_CODE_USE_ANTHROPIC_AWS: z.string().min(1),
    /** Claude on AWS のワークスペース API キー(§9.1)。ログに出さない。必須。 */
    ANTHROPIC_AWS_API_KEY: z.string().min(1),
    /** Claude on AWS のワークスペース ID(ADR-0009)。必須。 */
    ANTHROPIC_AWS_WORKSPACE_ID: z.string().min(1),
    /** Claude on AWS のリージョン(ADR-0009)。必須。 */
    AWS_REGION: z.string().min(1),
    /** スラッシュコマンド登録先ギルド(任意。未指定はグローバル登録)。 */
    DISCORD_GUILD_ID: z.string().optional(),
    // GitHub 認証(👍 代理マージ用・gh-client。App trio か token。未整備なら機能 OFF・ADR-0011)。
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
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
    // 全 AI 操作は Claude on AWS 経由(ADR-0009)。フラグが立っていないと Agent SDK が Claude on AWS に
    // ルーティングしないため、"1"/"true" を必須にする。
    if (env.CLAUDE_CODE_USE_ANTHROPIC_AWS !== "1" && env.CLAUDE_CODE_USE_ANTHROPIC_AWS !== "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLAUDE_CODE_USE_ANTHROPIC_AWS"],
        message:
          'CLAUDE_CODE_USE_ANTHROPIC_AWS は "1" または "true" にしてください(全 AI 操作は Claude on AWS 経由・ADR-0009)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** process.env(または注入した source)を検証して返す。失敗時は zod エラーを throw。 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
