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
    /** voice-memo の STT 用 OpenAI キー(ADR-0015 D3)。未設定なら voice-memo OFF。ログに出さない。 */
    OPENAI_API_KEY: z.string().optional(),
    /** repos.yaml の url に注入する clone 用トークン(config に平文で置かない・㉞)。 */
    GIT_CLONE_TOKEN: z.string().optional(),
    /** /ask の agentic search 上限 ms(既定 600000・ADR-0035 D1)。KB 成長で伸びたら env で調整。 */
    ASK_TIMEOUT_MS: z.string().optional(),
    /** /ask の最大ターン数(既定 30・ADR-0035 D6)。下げると error_max_turns が汎用エラーになるため慎重に。 */
    ASK_MAX_TURNS: z.string().optional(),
    /** /ask の努力度(low/medium/high。未設定 = SDK 既定・ADR-0035 D6 の実験ノブ)。 */
    ASK_EFFORT: z.enum(["low", "medium", "high"]).optional(),
    /** /ask の拡張思考(adaptive/disabled。未設定 = SDK 既定・ADR-0035 D6 の実験ノブ)。 */
    ASK_THINKING: z.enum(["adaptive", "disabled"]).optional(),
    /**
     * 正常終了(SIGTERM)で処理中の /ask を待つ上限 ms(既定 60000・ADR-0035 追記)。
     * compose の stop_grace_period(90 秒)より十分短くする(中断後の後処理に最大 15 秒使う)。
     */
    SHUTDOWN_GRACE_MS: z.string().optional(),
    /** VC 録音 sidecar の URL(ADR-0020。compose 内部ネットワーク・例 http://recorder:9488)。未設定なら VC 入口 OFF。 */
    RECORDER_URL: z.string().optional(),
    /** 録音ファイルの共有マウント(sidecar と同一パス・ADR-0020 D4)。 */
    RECORDINGS_DIR: z.string().default("/recordings"),
    /** 検索対象リポの clone ルート(cwd)。 */
    CLONES_DIR: z.string().default("./.clones"),
    /** SQLite ファイルパス。 */
    DB_PATH: z.string().default("./data/bot.db"),
    /** channels.yaml / repos.yaml / ops.yaml / voice.yaml の置き場(members は KB の _meta/members.yaml・ADR-0017 D3)。 */
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

/**
 * 任意の正整数 env を解釈する(ADR-0035)。未設定・空なら fallback。不正値(非整数・0 以下)は
 * warn を出して fallback に倒す(起動を止めない)。/ask の調整ノブ(ASK_TIMEOUT_MS 等)で共用。
 */
export function parsePositiveIntEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  warn: (data: Record<string, unknown>, msg: string) => void,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  warn({ env: name, raw }, `不正な ${name} のため既定(${fallback})で実行します`);
  return fallback;
}
