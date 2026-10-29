/**
 * System One の較正用ラベルの書き出し(ADR-0041 D7)。bot.db の回答済みの質問から
 * `{question, citedKinds, citedPaths, createdAt, systemOneMode}` の JSONL を作る。
 *
 * - bot.db は**読み取り専用**で開く(CLI 側)。ここは行 → ラベルの純関数と、書き出し先の検査だけ。
 * - 出力は質問文を含む機微なデータ。**git の作業ツリーの中には書かない**(commit 事故を防ぐ)。
 *   commit してよいのは較正後の数値の重み(weights.json)だけ。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyPath } from "./catalog.js";

/** 引用の種別(較正の正解ラベル)。 */
export type CitedKind = "kb" | "minutes" | "code" | "discord";

export interface LabelRow {
  question: string;
  citedKinds: CitedKind[];
  citedPaths: { kind: string; repo?: string; path?: string; url?: string }[];
  createdAt: string;
  /** その質問で System One が前置きしたか(on)・記録だけか(shadow)・無効(null)。自己強化の切り分けに使う。 */
  systemOneMode: string | null;
}

/** bot.db から読む 1 行(queries + system_one_decisions)。 */
export interface QueryLabelSource {
  question: string;
  sourcesJson: string | null;
  createdAt: string;
  systemOneMode: string | null;
}

/** 引用 1 件の種別。github_file は位置で KB / 議事録 / それ以外(コード等)に分ける。 */
export function citedKindOf(c: { kind?: unknown; path?: unknown }): CitedKind | null {
  if (c.kind === "discord") return "discord";
  if (c.kind === "github_pr" || c.kind === "github_issue") return "code";
  if (c.kind !== "github_file" || typeof c.path !== "string") return null;
  const k = classifyPath(c.path);
  return k === "other" ? "code" : k;
}

/** 行 → ラベル(sources_json が読めない・引用が無い行は捨てる)。 */
export function toLabelRows(rows: readonly QueryLabelSource[]): LabelRow[] {
  const out: LabelRow[] = [];
  for (const r of rows) {
    if (r.sourcesJson === null) continue;
    let sources: unknown;
    try {
      sources = JSON.parse(r.sourcesJson);
    } catch {
      continue;
    }
    if (!Array.isArray(sources)) continue;
    const citedPaths: LabelRow["citedPaths"] = [];
    const kinds: CitedKind[] = [];
    for (const s of sources as Record<string, unknown>[]) {
      const kind = citedKindOf(s);
      if (kind === null) continue;
      kinds.push(kind);
      citedPaths.push({
        kind: String(s.kind),
        ...(typeof s.repo === "string" ? { repo: s.repo } : {}),
        ...(typeof s.path === "string" ? { path: s.path } : {}),
        ...(typeof s.url === "string" ? { url: s.url } : {}),
      });
    }
    if (citedPaths.length === 0) continue;
    out.push({
      question: r.question,
      citedKinds: kinds,
      citedPaths,
      createdAt: r.createdAt,
      systemOneMode: r.systemOneMode,
    });
  }
  return out;
}

/**
 * 書き出し先が git の作業ツリーの外かを確かめる(内側なら理由を返す)。
 * 親ディレクトリを根まで辿り、`.git` があれば作業ツリーの中とみなす。
 */
export function outsideGitWorktree(
  outPath: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  let dir = dirname(resolve(outPath));
  for (;;) {
    if (exists(join(dir, ".git"))) {
      return `出力先 ${dir} は git の作業ツリーの中です。質問文を含むためリポジトリの外に書き出してください`;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
