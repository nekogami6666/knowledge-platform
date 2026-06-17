/**
 * 構造化ログ(design.md §7.4)。pino。相関 ID(query id / batch run id 等)を子ロガーに付与する。
 * シークレットはログに出さない(§9.1)。
 */
import { type Logger, pino } from "pino";

/** ルートロガーを作る。 */
export function createLogger(level: string = "info"): Logger {
  return pino({ level });
}

/** 相関 ID を付けた子ロガーを返す(1 リクエストを一意に追跡)。 */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
