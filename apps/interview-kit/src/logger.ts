/**
 * 最小構造化ロガー(design.md §7.4)。extractor / gap-tracker / freshness-checker と同一の最小実装
 * (バッチ用途・依存なし・秘密値スクラブ §9.1)。共有パッケージへの統合は独立 PR で行う(§2-F 方針)。
 */
const REDACTED = "[REDACTED]";

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * @param secretValues ログ最終行から伏字化する秘密の実値(env のキー/トークン等)。
 * @param write 出力先(テスト差し替え用。既定は標準出力)。
 */
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
