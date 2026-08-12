import { randomBytes } from "node:crypto";

/**
 * エントリ ID 採番(design.md §4.2, §6.1 / ADR-0026)。
 *
 * `<kind>-<年4桁>-<base36 6文字>` を乱数で採番する。旧方式(`_meta/id-counter.json` を介した
 * 連番 + CAS)は ADR-0026 で廃止した — 全書き手が counter を PR に同梱するため、同時に open な
 * KB PR が必ずコンフリクトする構造だったため。乱数採番は書き手間の調整を一切必要とせず、
 * 万一の衝突(年内 36^6 ≒ 22億通り)は KB validate CI の duplicate_id 検査が PR を赤にして止める。
 *
 * 旧形式(`<kind>-<年4桁>-<連番4桁>`)の既存 ID はリネームせず恒久共存する(schemas/common.ts が
 * 両形式を受理)。suffix はちょうど4桁(旧)/6文字(新)なので長さで機械判別できる。
 */

export type IdKind = "kb" | "dr" | "q";

/** base36。`-` を含めないこと(ファイル名 `<id>-<slug>.md` の ID 切り出し規約・ADR-0026)。 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SUFFIX_LENGTH = 6;

/** JST(+09:00)基準の年を返す(design.md §7.5)。 */
function jstYear(now: Date): string {
  return String(new Date(now.getTime() + 9 * 3600 * 1000).getUTCFullYear());
}

/** 乱数 suffix(base36 6文字)。剰余の偏りは一意性用途では無視できる。 */
function randomSuffix(): string {
  const bytes = randomBytes(SUFFIX_LENGTH);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export interface NewIdOptions {
  /** 年の決定に使う時刻(源泉日。テスト・源泉日採番用に注入可能。既定 = 現在時刻)。 */
  now?: Date;
  /** suffix 生成の seam(テスト決定性用。既定 = 乱数)。base36 6文字・`-` 不可。 */
  random?: () => string;
}

/** 新しいエントリ ID を採番する(`<kind>-<年4桁>-<base36 6文字>`)。 */
export function newId(kind: IdKind, options: NewIdOptions = {}): string {
  const now = options.now ?? new Date();
  const suffix = (options.random ?? randomSuffix)();
  return `${kind}-${jstYear(now)}-${suffix}`;
}
