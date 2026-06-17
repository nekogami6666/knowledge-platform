/**
 * 構造化ログ(design.md §7.4)。pino。相関 ID(query id / batch run id 等)を子ロガーに付与する。
 * シークレットはログに出さない(§9.1): redact で既知の token/key パスを [REDACTED] に伏字化する。
 */
import { type DestinationStream, type Logger, pino } from "pino";

/**
 * 伏字化するシークレットのパス(§9.1)。pino の `*` は1階層のみマッチするため、
 * トップレベル・1階層ネスト・既知の err.config 配下を列挙する。新たに秘密を載せる箇所が
 * 増えたらここへ追記する。
 */
const REDACT_PATHS = [
  "DISCORD_TOKEN",
  "ANTHROPIC_API_KEY",
  "*.DISCORD_TOKEN",
  "*.ANTHROPIC_API_KEY",
  "err.config.DISCORD_TOKEN",
  "err.config.ANTHROPIC_API_KEY",
];

/** ルートロガーを作る。destination はテスト用の差し替え口(既定は標準出力)。 */
export function createLogger(level: string = "info", destination?: DestinationStream): Logger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/** 相関 ID を付けた子ロガーを返す(1 リクエストを一意に追跡)。 */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
