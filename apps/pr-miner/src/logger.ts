/**
 * 最小構造化ロガー(design.md §7.4)。extractor/logger.ts と同一実装のアプリ内コピー。
 * バッチ用途なので pino(常駐向け)は使わず依存なしの最小実装にする(gap-tracker も同方針)。
 * 秘密の実値は [REDACTED] にスクラブ(§9.1)。
 */
const REDACTED = "[REDACTED]";

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(
  secretValues: readonly string[] = [],
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
): Logger {
  const scrub = (s: string): string =>
    secretValues.reduce((acc, v) => (v.length > 0 ? acc.split(v).join(REDACTED) : acc), s);
  const emit = (level: string, msg: string, data?: Record<string, unknown>): void => {
    const record = { level, msg, ...(data ?? {}) };
    write(`${scrub(JSON.stringify(record))}\n`);
  };
  return {
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}
