/**
 * 構造化ログ(design.md §7.4)。pino。相関 ID(query id / batch run id 等)を子ロガーに付与する。
 * シークレットはログに出さない(§9.1)。pino 既定の redact は `*` が1階層のみで、深いネスト・配列・
 * 文字列(err.message)埋め込みを取りこぼすため、2系統の防御を併用する:
 *  - (B) キー深さ非依存リダクト: ログオブジェクトを再帰 walk し、既知の秘密キー名の値を任意深さ・
 *    配列でも [REDACTED] 化(formatters.log)。
 *  - (A) 値スクラブ: 最終 JSON 行から env 由来の秘密「値」を [REDACTED] に文字列置換(destination ラップ)。
 *    err.message / err.stack に混入した秘密も捕捉する。
 */
import { type DestinationStream, type Logger, pino, stdSerializers } from "pino";

/** (B) 値を伏字化する秘密キー名(任意深さ・配列で適用)。新しい秘密キーはここへ追加。 */
const SECRET_KEYS = new Set(["DISCORD_TOKEN", "ANTHROPIC_AWS_API_KEY"]);
const REDACTED = "[REDACTED]";
const MAX_REDACT_DEPTH = 8;

/** (B) キー名一致の値を任意深さ・配列で伏字化した複製を返す(循環は [Circular]、深さ上限あり)。 */
function redactByKeyDeep(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  // Error は再構築すると message/stack(非列挙)を失う。そのまま返し serializers.err に整形させ、
  // 文字列に混入した秘密値は (A) のスクラブで消す。
  if (value instanceof Error) return value;
  if (depth >= MAX_REDACT_DEPTH) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactByKeyDeep(v, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) ? REDACTED : redactByKeyDeep(v, seen, depth + 1);
  }
  return out;
}

/** (A) シリアライズ済みログ行から既知の秘密「値」を伏字化する(空値はスキップ)。 */
function scrubSecretValues(line: string, secretValues: readonly string[]): string {
  let out = line;
  for (const s of secretValues) {
    if (s.length === 0) continue;
    out = out.split(s).join(REDACTED);
  }
  return out;
}

/**
 * ルートロガーを作る。
 * @param level ログレベル。
 * @param destination テスト用の差し替え口(既定は標準出力)。
 * @param secretValues (A) で伏字化する秘密の実値(index.ts で env のトークン/キーを渡す)。
 */
export function createLogger(
  level: string = "info",
  destination?: DestinationStream,
  secretValues: readonly string[] = [],
): Logger {
  const options = {
    level,
    // (B) 構造化オブジェクトのキー名ベース・深さ非依存リダクト。
    formatters: {
      log: (obj: Record<string, unknown>): Record<string, unknown> =>
        redactByKeyDeep(obj, new WeakSet(), 0) as Record<string, unknown>,
    },
    // Error を {type,message,stack} に整形(秘密が混入しても (A) が消す)。
    serializers: { err: stdSerializers.err },
  };
  const base: DestinationStream = destination ?? {
    write: (s: string) => {
      process.stdout.write(s);
    },
  };
  // (A) 最終行に対する値スクラブを噛ませた sink。
  const sink: DestinationStream = {
    write: (s: string) => base.write(scrubSecretValues(s, secretValues)),
  };
  return pino(options, sink);
}

/** 相関 ID を付けた子ロガーを返す(1 リクエストを一意に追跡)。 */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
