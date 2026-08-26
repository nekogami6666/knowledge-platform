/**
 * discord ソース実行専用の env 検証(ADR-0033)。Actions 経路の ../env.ts に discord 変数を
 * 要求させないため別ファイル。全 AI は Claude on AWS(ADR-0009)。
 * シークレット(DISCORD_TOKEN / ANTHROPIC_AWS_API_KEY / GIT_CLONE_TOKEN / GITHUB_* /
 * DISCORD_OPS_WEBHOOK)はログに出さない(§9.1)。
 */
import { z } from "zod";

const envSchema = z
  .object({
    CLAUDE_CODE_USE_ANTHROPIC_AWS: z.string().min(1),
    ANTHROPIC_AWS_API_KEY: z.string().min(1),
    ANTHROPIC_AWS_WORKSPACE_ID: z.string().min(1),
    AWS_REGION: z.string().min(1),
    /** 収集セッション用(bot と同一 token・Guilds のみの第 2 セッション・ADR-0033 D5)。 */
    DISCORD_TOKEN: z.string().min(1),
    /** KB clone 認証(config の URL には書かない・#139)。 */
    GIT_CLONE_TOKEN: z.string().optional(),
    /** app 専用 clone ディレクトリ(bot の /clones と共有しない — 実障害の前例あり)。 */
    CLONES_DIR: z.string().min(1),
    /** bot の config dir(channels.yaml = permanent_exclude を共有・ADR-0018)。 */
    CHANNELS_CONFIG_DIR: z.string().min(1),
    // GitHub 書き込み(gh-client。App trio か token)。実 PR/commit(REAL)時のみ必須。
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    /** #stratum-ops への通知 webhook(未設定なら通知 no-op)。 */
    DISCORD_OPS_WEBHOOK: z.string().optional(),
    /** "1"/"true" で実 PR + state commit。既定は dry-run(ログのみ)。 */
    EXTRACTOR_DISCORD_REAL: z.string().optional(),
    /** LLM 1 呼び出しの上限 ms。不正値/未設定は既定 300_000(index.ts で解釈)。 */
    EXTRACTOR_DISCORD_TIMEOUT_MS: z.string().optional(),
    /** reconcile の並列上限。不正値/未設定は既定 4(index.ts で解釈)。 */
    EXTRACTOR_DISCORD_RECONCILE_CONCURRENCY: z.string().optional(),
    CONFIG_DIR: z.string().default("./apps/extractor/config"),
    PROMPTS_DIR: z.string().default("./prompts"),
  })
  .superRefine((env, ctx) => {
    if (env.CLAUDE_CODE_USE_ANTHROPIC_AWS !== "1" && env.CLAUDE_CODE_USE_ANTHROPIC_AWS !== "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLAUDE_CODE_USE_ANTHROPIC_AWS"],
        message:
          'CLAUDE_CODE_USE_ANTHROPIC_AWS は "1" または "true" にしてください(全 AI 操作は Claude on AWS 経由・ADR-0009)',
      });
    }
  });

export type DiscordEnv = z.infer<typeof envSchema>;

export function parseDiscordEnv(
  source: Record<string, string | undefined> = process.env,
): DiscordEnv {
  return envSchema.parse(source);
}

/** 実 PR + state commit してよいか(既定 false = dry-run)。 */
export function isDiscordReal(env: DiscordEnv): boolean {
  return env.EXTRACTOR_DISCORD_REAL === "1" || env.EXTRACTOR_DISCORD_REAL === "true";
}
