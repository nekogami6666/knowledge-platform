/**
 * System One のカタログ(ADR-0041 D4)。同期済み clone から KB エントリと議事録の一覧(本文つき)を作り、
 * **メモリにだけ**持つ(ディスクに書かない・ADR-0035 D6 / §5.3「索引の同期負債なし」)。
 * リポ + HEAD の SHA をキーにキャッシュし、HEAD が変わったリポだけ作り直す。
 *
 * - KB: 各リポの `knowledge/`・`decisions/` 配下の .md のうち、kb-core の safeParseEntry で parse できたもの。
 *   どのリポが KB かは設定やリポ名でなく内容で判定する(ask.ts の isStaleKbEntry と同じ流儀・ADR-0036 D6)。
 * - 議事録: `meetings/` 配下の `minutes.md` だけ(transcript.md は読まない)。加えて synthetic コーパスの
 *   `[minutes/]<yyyy>/<mm>/<yyyy-mm-dd>-*.md`。日付は minutesDateFromPath(@stratum/shared)。
 * - 封じ込め(ADR-0037 と同じ考え方): clone の実体ディレクトリ配下だけを辿る。symlink はディレクトリ・ファイルとも
 *   辿らない(readdir の型で除外し、ファイルは O_NOFOLLOW で開く)。サイズ・件数・深さに上限を置く。
 */
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { safeParseEntry } from "@stratum/kb-core";
import { minutesDateFromPath } from "@stratum/shared";
import { normalizeText } from "./terms.js";

export type CatalogKind = "kb" | "minutes";

/** カタログの 1 件(KB エントリ or 議事録)。 */
export interface CatalogEntry {
  kind: CatalogKind;
  /** "org/name"(引用の repo)。 */
  repo: string;
  /** リポ相対のパス(/ 区切り・引用の path)。 */
  path: string;
  title: string;
  /** YYYY-MM-DD(KB = created / decision の date、議事録 = パスの日付)。不明は null。 */
  date: string | null;
  /** KB の domain(議事録は null)。 */
  domain: string | null;
  tags: readonly string[];
  /** KB の status(active / stale 等。議事録は null)。 */
  status: string | null;
  /** 議事録のエグゼクティブサマリー先頭行(120 字まで)。無ければ null。 */
  summary: string | null;
  /** 本文(NFKC 済み・大小は保つ。抜粋の切り出し用)。 */
  body: string;
  /** 照合用(normalizeText 済み)。 */
  norm: { title: string; meta: string; summary: string; body: string };
}

/** 1 リポ分のカタログ。 */
export interface RepoCatalog {
  repo: string;
  /** 作成時の HEAD SHA(キャッシュのキー)。 */
  sha: string;
  entries: readonly CatalogEntry[];
  stats: CatalogBuildStats;
}

export interface CatalogBuildStats {
  files: number;
  bytes: number;
  /** kb-core で parse できず外した KB 側の .md の数。 */
  kbParseErrors: number;
  /** 上限(サイズ・件数・深さ)で外した数。 */
  skipped: number;
  /** 合計の上限に達して打ち切ったか。 */
  truncated: boolean;
  ms: number;
}

/** カタログ作成の上限(ADR-0041 D4)。 */
export interface CatalogLimits {
  /** 1 ファイルの上限バイト(超えたら読まない)。 */
  maxFileBytes: number;
  /** 1 リポの合計バイトの上限(超えたら打ち切る)。 */
  maxTotalBytes: number;
  /** 1 リポのファイル数の上限。 */
  maxFiles: number;
  /** ディレクトリの深さの上限(起点ディレクトリ = 0)。 */
  maxDepth: number;
  /** 読み取りの並列度。 */
  concurrency: number;
}

export const DEFAULT_CATALOG_LIMITS: CatalogLimits = {
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 20_000,
  maxDepth: 10,
  concurrency: 16,
};

/** 議事録の summary の上限字数。 */
export const SUMMARY_MAX_CHARS = 120;

/** synthetic コーパスの日付つき議事録(`2026/06/2026-06-03-hw-weekly.md`)。 */
const DATED_MINUTES_RE = /(?:^|\/)\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}[^/]*\.md$/;

/**
 * リポ相対パスの種別(カタログの対象判定・ラベル書き出しの種別分け)。
 * KB 側は「parse できたら KB」なので、ここでは位置だけで見る(knowledge/ と decisions/ の .md)。
 */
export function classifyPath(path: string): CatalogKind | "other" {
  if (/^(knowledge|decisions)\/.+\.md$/.test(path)) return "kb";
  if (/(^|\/)transcript\.md$/.test(path)) return "other";
  if (/^meetings\/(.+\/)?minutes\.md$/.test(path)) return "minutes";
  if (DATED_MINUTES_RE.test(path) && /^(minutes\/)?\d{4}\//.test(path)) return "minutes";
  return "other";
}

/** パス → 日付文字列(JST・YYYY-MM-DD)。 */
function pathDate(path: string): string | null {
  const d = minutesDateFromPath(path);
  return d === null ? null : new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 議事録の title(最初の見出し)と summary(エグゼクティブサマリーの先頭行)。 */
export function parseMinutesHead(raw: string): { title: string | null; summary: string | null } {
  const lines = raw.split(/\r?\n/);
  let title: string | null = null;
  let summary: string | null = null;
  let inSummary = false;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h !== null) {
      const text = h[2] ?? "";
      if (title === null) title = text;
      if (summary !== null) break;
      inSummary = /^##$/.test(h[1] ?? "") && /エグゼクティブ\s*サマリー/.test(text);
      continue;
    }
    if (inSummary && summary === null) {
      const t = line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (t !== "") {
        const chars = [...t];
        summary =
          chars.length <= SUMMARY_MAX_CHARS
            ? t
            : `${chars.slice(0, SUMMARY_MAX_CHARS - 1).join("")}…`;
        if (title !== null) break;
      }
    }
  }
  return { title, summary };
}

function makeEntry(e: Omit<CatalogEntry, "norm" | "body"> & { body: string }): CatalogEntry {
  const body = e.body.normalize("NFKC");
  return {
    ...e,
    body,
    norm: {
      title: normalizeText(e.title),
      meta: normalizeText([e.domain ?? "", ...e.tags, e.path].join(" ")),
      summary: normalizeText(e.summary ?? ""),
      body: body.toLowerCase(),
    },
  };
}

/** 対象ファイル 1 件(リポ相対パスと種別)。 */
interface Target {
  rel: string;
  kind: "knowledge" | "decision" | "minutes";
}

/**
 * 起点ディレクトリ配下を symlink を辿らずに列挙する。ドットで始まる名前(.git 等)は辿らない。
 * 起点自体が実ディレクトリでなければ(無い・symlink)何も返さない。
 */
async function walk(
  root: string,
  startRel: string,
  accept: (rel: string, name: string) => boolean,
  limits: CatalogLimits,
  out: string[],
  counters: { skipped: number },
): Promise<void> {
  const stack: { rel: string; depth: number }[] = [{ rel: startRel, depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await readdir(join(root, cur.rel), { withFileTypes: true });
    } catch {
      continue; // 無い・読めない
    }
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      const rel = `${cur.rel}/${d.name}`;
      if (d.isSymbolicLink()) continue; // 辿らない(ADR-0037)
      if (d.isDirectory()) {
        if (cur.depth + 1 > limits.maxDepth) {
          counters.skipped += 1;
          continue;
        }
        stack.push({ rel, depth: cur.depth + 1 });
      } else if (d.isFile() && accept(rel, d.name)) {
        if (out.length >= limits.maxFiles) {
          counters.skipped += 1;
          continue;
        }
        out.push(rel);
      }
    }
  }
}

/**
 * clone の実体配下だけを読む(O_NOFOLLOW・サイズ上限)。読めない・大きすぎる・symlink は null。
 * 上限を超えたファイルは fstat の時点で読まずに外す。
 */
async function readBounded(abs: string, maxBytes: number): Promise<string | null> {
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fh.readFile({ encoding: "utf8" });
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** 並列度を抑えて map する(順序は入力どおり)。 */
async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return out;
}

export interface BuildRepoCatalogInput {
  repo: string;
  /** clone の絶対パス。 */
  absDir: string;
  sha: string;
  limits?: Partial<CatalogLimits>;
  /** 単調クロック(ms・所要時間の計測)。 */
  monotonicMs?: () => number;
}

/** 1 リポのカタログを作る(I/O あり・throw しない。読めないものは外す)。 */
export async function buildRepoCatalog(input: BuildRepoCatalogInput): Promise<RepoCatalog> {
  const limits = { ...DEFAULT_CATALOG_LIMITS, ...input.limits };
  const mono = input.monotonicMs ?? (() => performance.now());
  const t0 = mono();
  const stats: CatalogBuildStats = {
    files: 0,
    bytes: 0,
    kbParseErrors: 0,
    skipped: 0,
    truncated: false,
    ms: 0,
  };
  let root: string;
  try {
    root = await realpath(input.absDir);
  } catch {
    return { repo: input.repo, sha: input.sha, entries: [], stats };
  }
  // 起点の候補(リポ直下の実ディレクトリだけ)。
  let top: import("node:fs").Dirent[];
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return { repo: input.repo, sha: input.sha, entries: [], stats };
  }
  const counters = { skipped: 0 };
  const targets: Target[] = [];
  for (const d of top) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    const found: string[] = [];
    if (d.name === "knowledge" || d.name === "decisions") {
      await walk(root, d.name, (_rel, name) => name.endsWith(".md"), limits, found, counters);
      const kind = d.name === "knowledge" ? "knowledge" : "decision";
      for (const rel of found) targets.push({ rel, kind });
    } else if (d.name === "meetings") {
      await walk(root, d.name, (_rel, name) => name === "minutes.md", limits, found, counters);
      for (const rel of found) targets.push({ rel, kind: "minutes" });
    } else if (d.name === "minutes" || /^\d{4}$/.test(d.name)) {
      await walk(
        root,
        d.name,
        (rel, name) => name !== "transcript.md" && classifyPath(rel) === "minutes",
        limits,
        found,
        counters,
      );
      for (const rel of found) targets.push({ rel, kind: "minutes" });
    }
  }
  targets.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)); // 決定的な順序
  const capped = targets.slice(0, limits.maxFiles);
  counters.skipped += targets.length - capped.length;

  let total = 0;
  const raws = await mapBounded(capped, limits.concurrency, async (t) => {
    if (total >= limits.maxTotalBytes) return null;
    const raw = await readBounded(join(root, t.rel), limits.maxFileBytes);
    if (raw === null) {
      counters.skipped += 1;
      return null;
    }
    total += Buffer.byteLength(raw, "utf8");
    if (total > limits.maxTotalBytes) {
      stats.truncated = true;
      return null;
    }
    return raw;
  });

  const entries: CatalogEntry[] = [];
  capped.forEach((t, i) => {
    const raw = raws[i];
    if (raw === null || raw === undefined) return;
    stats.files += 1;
    stats.bytes += Buffer.byteLength(raw, "utf8");
    if (t.kind === "knowledge") {
      const r = safeParseEntry(raw, "knowledge", t.rel);
      if (!r.ok) {
        stats.kbParseErrors += 1;
        return;
      }
      const fm = r.entry.frontmatter;
      entries.push(
        makeEntry({
          kind: "kb",
          repo: input.repo,
          path: t.rel,
          title: fm.title,
          date: fm.created,
          domain: fm.domain,
          tags: fm.tags,
          status: fm.status,
          summary: null,
          body: r.entry.body,
        }),
      );
    } else if (t.kind === "decision") {
      const r = safeParseEntry(raw, "decision", t.rel);
      if (!r.ok) {
        stats.kbParseErrors += 1;
        return;
      }
      const fm = r.entry.frontmatter;
      entries.push(
        makeEntry({
          kind: "kb",
          repo: input.repo,
          path: t.rel,
          title: fm.title,
          date: fm.date,
          domain: null,
          tags: fm.tags,
          status: fm.status,
          summary: null,
          body: r.entry.body,
        }),
      );
    } else {
      const head = parseMinutesHead(raw);
      entries.push(
        makeEntry({
          kind: "minutes",
          repo: input.repo,
          path: t.rel,
          title: head.title ?? t.rel.split("/").slice(-2).join("/"),
          date: pathDate(t.rel),
          domain: null,
          tags: [],
          status: null,
          summary: head.summary,
          body: raw,
        }),
      );
    }
  });
  stats.skipped += counters.skipped;
  stats.ms = Math.round(mono() - t0);
  return { repo: input.repo, sha: input.sha, entries, stats };
}

/** カタログ全体(リポ横断)。 */
export interface Catalog {
  entries: readonly CatalogEntry[];
  repos: readonly RepoCatalog[];
}

/** カタログの対象リポ(SyncedRepo と同形の最小)。 */
export interface CatalogRepoRef {
  repo: string;
  absDir: string;
  /** HEAD の SHA(SyncedRepo.resolvedCommit)。 */
  sha: string;
}

/**
 * リポ + HEAD SHA をキーにしたメモリキャッシュ。HEAD が変わったリポだけ作り直し、範囲外になったリポは捨てる。
 * 同じキーの作成が進行中なら同じ Promise を共有する(二重に読まない)。
 */
export interface CatalogCache {
  refresh(repos: readonly CatalogRepoRef[]): Promise<Catalog>;
  /** 直近に完成したカタログ(作成中は前のもの。未作成は null)。 */
  current(): Catalog | null;
}

export function createCatalogCache(
  deps: {
    build?: (input: BuildRepoCatalogInput) => Promise<RepoCatalog>;
    limits?: Partial<CatalogLimits>;
  } = {},
): CatalogCache {
  const build = deps.build ?? buildRepoCatalog;
  const done = new Map<string, RepoCatalog>(); // repo → 完成したカタログ
  const pending = new Map<string, Promise<RepoCatalog>>(); // `${repo}@${sha}` → 作成中
  let last: Catalog | null = null;

  const one = (r: CatalogRepoRef): Promise<RepoCatalog> => {
    const have = done.get(r.repo);
    if (have !== undefined && have.sha === r.sha) return Promise.resolve(have);
    const key = `${r.repo}@${r.sha}`;
    const inflight = pending.get(key);
    if (inflight !== undefined) return inflight;
    const p = build({
      repo: r.repo,
      absDir: r.absDir,
      sha: r.sha,
      ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
    })
      .then((c) => {
        done.set(r.repo, c);
        return c;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };

  return {
    async refresh(repos) {
      const built = await Promise.all(repos.map(one));
      const keep = new Set(repos.map((r) => r.repo));
      for (const k of [...done.keys()]) if (!keep.has(k)) done.delete(k);
      last = { repos: built, entries: built.flatMap((c) => c.entries) };
      return last;
    },
    current: () => last,
  };
}
