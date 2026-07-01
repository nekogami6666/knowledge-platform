/**
 * extractor の環境変数検証(design.md §9.1 / ADR-0009)。全 AI は Claude on AWS(Agent SDK)。
 * GitHub 認証(gh-client)は未整備の間 optional。実 PR 作成は EXTRACTOR_REAL_PR フラグで guard(既定 dry-run)。
 * シークレット(ANTHROPIC_AWS_API_KEY / GITHUB_TOKEN / GITHUB_APP_PRIVATE_KEY / DISCORD_OPS_WEBHOOK)はログに出さない。
 */
import { z } from "zod";

const envSchema = z
  .object({
    CLAUDE_CODE_USE_ANTHROPIC_AWS: z.string().min(1),
    ANTHROPIC_AWS_API_KEY: z.string().min(1),
    ANTHROPIC_AWS_WORKSPACE_ID: z.string().min(1),
    AWS_REGION: z.string().min(1),
    // GitHub 認証(gh-client。App trio か token。未整備の間 optional)。
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    /** #stratum-ops への通知 webhook(未設定なら通知 no-op)。 */
    DISCORD_OPS_WEBHOOK: z.string().optional(),
    /** "1"/"true" で実 PR 作成。既定は dry-run(FileChange をログのみ)。 */
    EXTRACTOR_REAL_PR: z.string().optional(),
    CLONES_DIR: z.string().default("./.clones"),
    CONFIG_DIR: z.string().default("./config"),
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

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

/** 実 PR を作成してよいか(既定 false=dry-run)。 */
export function isRealPr(env: Env): boolean {
  return env.EXTRACTOR_REAL_PR === "1" || env.EXTRACTOR_REAL_PR === "true";
}
