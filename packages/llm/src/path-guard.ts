/**
 * agentic search のファイル読み取り封じ込めガード(ADR-0037)。
 *
 * Agent SDK の `cwd` は FS 境界ではなく、`allowedTools:["Read",...]` の素の許可は cwd 外の絶対パス・
 * `../`・cwd 内から外を指す symlink もプロンプトなしで読ませる(本番 2026-09-30 実証)。本モジュールは
 * ツール入力が指す対象の **realpath** が `realpath(cwd)` 配下かを判定する純粋関数を提供し、
 * agent.ts が PreToolUse hook からこれを呼んで**拒否のみ**を返す(allow は決して返さない=能力を足さない)。
 *
 * 判定方針(fail-closed):
 * - 対象ツール(FILE_TOOLS)のパス系フィールドだけを検査し、それ以外のツール(StructuredOutput 等)は素通し
 * - `~` 始まり・NUL・`..` セグメントを含むパスは解決せずに拒否(lexical 正規化と OS の symlink 解決の
 *   食い違いを突く `link/../x` 型の抜け道を構造的に塞ぐ)
 * - 相対パスは root 基準で解決し、実在する最長の祖先を realpath してから残りを連結する(未存在パスも判定可能)
 * - realpath が ENOENT/ENOTDIR 以外で失敗(EACCES・ELOOP 等)したら拒否
 * - Glob の pattern はメタ文字より前の静的接頭辞をディレクトリとして同じ判定にかける(絶対 pattern 対策)
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** パス判定の結果。deny の reason はモデルへ返る(秘密を含めない)。 */
export type ContainmentDecision = { allowed: true } | { allowed: false; reason: string };

/** realpath の差し替え seam(既定は fs.realpathSync)。存在しなければ ENOENT を投げること。 */
export type RealpathFn = (p: string) => string;

/**
 * パスを入力に取るファイル系ツール。現行の許可ツールは Read/Grep/Glob のみだが、将来の追加や
 * 設定ミスで他のファイル系ツールが見えても同じ境界で拒否されるよう広めに列挙する。
 */
export const FILE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "NotebookEdit",
  "Edit",
  "MultiEdit",
  "Write",
  "LSP",
]);

/** ファイル系ツールでパスを表す入力キー。 */
const PATH_KEYS: readonly string[] = ["file_path", "path", "notebook_path"];

/** glob のメタ文字(これを含むセグメント以降は静的接頭辞に含めない)。 */
const GLOB_META = /[*?[\]{}!]/;

const deny = (reason: string): ContainmentDecision => ({ allowed: false, reason });
const ALLOW: ContainmentDecision = { allowed: true };

/** `target` が `root` 自身またはその配下か(両者とも realpath 済み・絶対パスが前提)。 */
export function isWithinRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined;
}

/**
 * 絶対パスの realpath を返す。末尾側が未存在なら、実在する最長の祖先を realpath して残りを連結する
 * (未存在ファイルの読み取りは無害だが、祖先の symlink で外へ出る判定は必要)。
 * ENOENT/ENOTDIR 以外の失敗は判定不能として null(呼び出し側で拒否)。
 */
export function resolveRealPath(
  absPath: string,
  realpath: RealpathFn = realpathSync,
): string | null {
  const rest: string[] = [];
  let cur = absPath;
  for (;;) {
    try {
      const real = realpath(cur);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch (e) {
      const code = errCode(e);
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      rest.push(cur.slice(parent.length).replace(/^[/\\]+/, ""));
      cur = parent;
    }
  }
}

/**
 * 検索ルート(cwd)の realpath。cwd 自体が symlink(例: /clones → /mnt/x)でも実体で比較するため。
 * 未存在なら lexical な絶対パスに倒す(その場合 agent 側も cwd を開けず失敗する)。
 */
export function resolveContainmentRoot(cwd: string, realpath: RealpathFn = realpathSync): string {
  const abs = resolve(cwd);
  try {
    return realpath(abs);
  } catch {
    return abs;
  }
}

function hasDotDotSegment(p: string): boolean {
  return p.split(/[/\\]+/).some((s) => s === "..");
}

/** 1 本のパス文字列を判定する。relBase は相対パスの解決基準(realpath 済み)。 */
function checkPath(
  raw: string,
  root: string,
  relBase: string,
  label: string,
  realpath: RealpathFn,
): ContainmentDecision {
  if (raw.includes("\0")) return deny(`${label}: 不正なパスです`);
  if (raw.startsWith("~")) {
    return deny(`${label}: ホームディレクトリ参照(~)は許可されていません: ${raw}`);
  }
  if (hasDotDotSegment(raw)) {
    return deny(
      `${label}: '..' を含むパスは許可されていません(検索ルート配下の絶対パスを使ってください): ${raw}`,
    );
  }
  const abs = isAbsolute(raw) ? raw : resolve(relBase, raw);
  const real = resolveRealPath(abs, realpath);
  if (real === null) return deny(`${label}: パスを解決できません: ${raw}`);
  if (!isWithinRoot(root, real)) {
    return deny(`${label}: 読み取りは検索ルート(作業ディレクトリ)配下に限定されています: ${raw}`);
  }
  return ALLOW;
}

/** Glob pattern のメタ文字より前の静的接頭辞(ディレクトリ部)を返す。 */
export function globStaticPrefix(pattern: string): string {
  const absolute = pattern.startsWith("/");
  const segs = pattern.split("/").filter((s) => s !== "");
  const out: string[] = [];
  for (const s of segs) {
    if (GLOB_META.test(s)) break;
    out.push(s);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined;
}

/** Glob の pattern を判定する(base は path 引数解決後の realpath、未指定なら root)。 */
function checkGlobPattern(
  pattern: string,
  root: string,
  base: string,
  realpath: RealpathFn,
): ContainmentDecision {
  if (pattern.includes("\0")) return deny("Glob pattern: 不正なパターンです");
  if (pattern.startsWith("~"))
    return deny(`Glob pattern: ホームディレクトリ参照(~)は許可されていません: ${pattern}`);
  // ブレース展開の選択肢に絶対パス / ~ を忍ばせる形({/etc,/config}/*)も拒否する。
  if (/[{,]\s*[/~]/.test(pattern)) {
    return deny(`Glob pattern: 絶対パスを含むブレース展開は許可されていません: ${pattern}`);
  }
  if (hasDotDotSegment(pattern)) {
    return deny(`Glob pattern: '..' を含むパターンは許可されていません: ${pattern}`);
  }
  const prefix = globStaticPrefix(pattern);
  if (prefix === "") return ALLOW; // base 直下の探索(base 自体は判定済み)
  return checkPath(prefix, root, base, "Glob pattern", realpath);
}

/**
 * ツール呼び出し 1 件の封じ込め判定。`root` は {@link resolveContainmentRoot} の戻り(realpath 済み)。
 * FILE_TOOLS 以外は常に allowed(このガードは能力を足さず、ファイル系の到達範囲だけを削る)。
 */
export function checkToolPathContainment(
  toolName: string,
  input: unknown,
  root: string,
  realpath: RealpathFn = realpathSync,
): ContainmentDecision {
  if (!FILE_TOOLS.has(toolName)) return ALLOW;
  if (typeof input !== "object" || input === null) return ALLOW; // パス無し=既定の cwd

  const rec = input as Record<string, unknown>;
  let base = root;
  for (const key of PATH_KEYS) {
    if (!(key in rec) || rec[key] === undefined || rec[key] === null) continue;
    const v = rec[key];
    if (typeof v !== "string")
      return deny(`${toolName}.${key}: 文字列ではないパスは許可されていません`);
    if (v === "") continue; // 空文字は未指定扱い(=cwd)
    const d = checkPath(v, root, root, `${toolName}.${key}`, realpath);
    if (!d.allowed) return d;
    if (key === "path") {
      // Glob の相対 pattern は path 基準で解決されるため、以降の判定の基準にする。
      base = resolveRealPath(isAbsolute(v) ? v : resolve(root, v), realpath) ?? root;
    }
  }

  if (toolName === "Glob" && rec.pattern !== undefined) {
    if (typeof rec.pattern !== "string") return deny("Glob.pattern: 文字列ではありません");
    return checkGlobPattern(rec.pattern, root, base, realpath);
  }
  return ALLOW;
}
