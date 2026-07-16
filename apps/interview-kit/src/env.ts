/**
 * interview-kit の環境変数検証(design.md §6.6 ⑤-b / §9.1 / ADR-0009)。
 * workflow_dispatch(person / topic)から起動される手動バッチ。質問生成は Claude on AWS
 * (Agent SDK・role: deep)。PR 作成(INTERVIEW_REAL)時のみ GitHub 認証(App)が要る。
 * KB clone は workflow の checkout に任せ、そのルートを KB_ROOT で受け取る(expertise-mapper と同じ)。
 * シークレット(ANTHROPIC_AWS_API_KEY / GITHUB_* / DISCORD_OPS_WEBHOOK)はログに出さない。
 */
import { z } from "zod";

const envSchema = z
  .object({
    CLAUDE_CODE_USE_ANTHROPIC_AWS: z.string().min(1),
    ANTHROPIC_AWS_API_KEY: z.string().min(1),
    ANTHROPIC_AWS_WORKSPACE_ID: z.string().min(1),
    AWS_REGION: z.string().min(1),
    /** KB clone のルート(workflow の actions/checkout が配置)。agentic read の cwd。 */
    KB_ROOT: z.string().min(1),
    /** "org/knowledge-base"(質問キット PR の作成先。vars 由来・ハードコードしない)。 */
    INTERVIEW_KB_REPO: z.string().min(1),
    /** 対象者(GitHub ユーザ名)。workflow_dispatch input。 */
    INTERVIEW_PERSON: z.string().min(1),
    /** トピック(expertise レポートの risk:high 等から人間が選ぶ)。workflow_dispatch input。 */
    INTERVIEW_TOPIC: z.string().min(1),
    // GitHub 認証(gh-client。App trio か token)。実 PR(INTERVIEW_REAL)時のみ必須。
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    /** #stratum-ops への通知 webhook(未設定なら通知 no-op)。 */
    DISCORD_OPS_WEBHOOK: z.string().optional(),
    /** "1"/"true" で実 PR 作成。既定は dry-run(質問リストをログに出すだけ)。 */
    INTERVIEW_REAL: z.string().optional(),
    /** LLM 1 呼び出しのタイムアウト(ms・正の整数)。不正値/未設定は既定 300_000。 */
    INTERVIEW_TIMEOUT_MS: z.string().optional(),
    PROMPTS_DIR: z.string().default("./prompts"),
  })
  .superRefine((env, ctx) => {
    if (env.CLAUDE_CODE_USE_ANTHROPIC_AWS !== "1" && env.CLAUDE_CODE_USE_ANTHROPIC_AWS !== "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLAUDE_CODE_USE_ANTHROPIC_AWS"],
        message: "Claude on AWS 経由のみ許可(ADR-0009)。'1' か 'true' を設定してください",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

/** 実 PR 作成を行ってよいか(既定 false=dry-run)。 */
export function isReal(env: Env): boolean {
  return env.INTERVIEW_REAL === "1" || env.INTERVIEW_REAL === "true";
}

/** タイムアウト(ms)。不正値は既定 300s に落とす(fail-safe)。 */
export function timeoutMs(env: Env): number {
  const n = Number(env.INTERVIEW_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 300_000;
}
