/**
 * expertise-mapper の環境変数検証(design.md §9.1 / ADR-0009 / ADR-0017)。
 * 全 AI は Claude on AWS(Agent SDK)。GitHub 認証は「commit evidence の読み取り(GITHUB_READ_TOKEN =
 * PAT)」と「expertise.yaml の main 直 commit(App)」の hybrid(ADR-0013 D4 の流儀・pr-miner と同じ)。
 * KB clone は workflow の checkout に任せ、そのルートを KB_ROOT で受け取る。
 * シークレット(ANTHROPIC_AWS_API_KEY / GITHUB_* / DISCORD_OPS_WEBHOOK)はログに出さない。
 */
import { z } from "zod";

const envSchema = z
  .object({
    CLAUDE_CODE_USE_ANTHROPIC_AWS: z.string().min(1),
    ANTHROPIC_AWS_API_KEY: z.string().min(1),
    ANTHROPIC_AWS_WORKSPACE_ID: z.string().min(1),
    AWS_REGION: z.string().min(1),
    /** KB clone のルート(workflow の actions/checkout が配置)。 */
    KB_ROOT: z.string().min(1),
    // GitHub 認証(gh-client。App trio か token。未整備の間 optional)。
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    /**
     * 対象リポの commit 読み取り用 PAT(fine-grained・Contents: Read)。
     * 設定すると読み取りだけこの PAT を使い、KB への書き込みは上の認証のまま(ADR-0013 D4 の hybrid)。
     */
    GITHUB_READ_TOKEN: z.string().optional(),
    /** #stratum-ops への通知 webhook(未設定なら通知 no-op)。 */
    DISCORD_OPS_WEBHOOK: z.string().optional(),
    /** "1"/"true" で実 commit。既定は dry-run(生成結果をログのみ)。 */
    EXPERTISE_REAL: z.string().optional(),
    /** LLM 1 呼び出しのタイムアウト(ms・正の整数)。不正値/未設定は既定 300_000。 */
    EXPERTISE_TIMEOUT_MS: z.string().optional(),
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

/** 実 commit してよいか(既定 false = dry-run)。 */
export function isReal(env: Env): boolean {
  return env.EXPERTISE_REAL === "1" || env.EXPERTISE_REAL === "true";
}

/**
 * 正の整数の env を解釈する(pr-miner/env.ts と同一実装のコピー)。
 * 未設定/空は既定値、NaN・非整数・0 以下は既定値 + warning。
 */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): { value: number; warning?: string } {
  if (raw === undefined || raw.trim() === "") return { value: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return {
      value: fallback,
      warning: `不正な数値 "${raw}" のため既定値 ${fallback} を使用します`,
    };
  }
  return { value: n };
}
