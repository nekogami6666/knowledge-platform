import { KbProvenanceError } from "./errors.js";
import { DISCORD_PERMALINK_RE, LINE_RANGE_RE, type Source } from "./schemas/source.js";

/**
 * provenance ヘルパ: sources 配列の各要素 ↔ GitHub / Discord permalink の相互変換。
 * §9.5 のとおり許可ドメインは github.com / discord.com のみ。
 *
 * ファイル系 source(meeting / voice-memo / interview)はいずれも GitHub blob URL に
 * 写るため URL → Source は kind を一意復元できない。逆変換ではファイル系を "meeting" に
 * 正規化する(round-trip 保証は pr / issue / discord と、kind を meeting とした file source)。
 */

export interface SourceUrlOptions {
  /** ファイル系/PR系で source.ref が無いときに使う既定ブランチ名(例 "main")。 */
  defaultBranch?: string;
}

/** "L120-L141" → "#L120-L141"、"L120" → "#L120"。 */
function lineAnchor(lines: string | undefined): string {
  if (lines === undefined) return "";
  const m = LINE_RANGE_RE.exec(lines);
  if (!m) throw new KbProvenanceError(`lines の形式が不正です: ${lines}`);
  return m[2] === undefined ? `#L${m[1]}` : `#L${m[1]}-L${m[2]}`;
}

function refOf(source: { ref?: string }, options?: SourceUrlOptions): string {
  const ref = source.ref ?? options?.defaultBranch;
  if (ref === undefined || ref.length === 0) {
    throw new KbProvenanceError(
      "ファイル/PR 参照の URL 生成には source.ref か options.defaultBranch が必要です",
    );
  }
  return ref;
}

/** Source → permalink 文字列。 */
export function sourceToUrl(source: Source, options?: SourceUrlOptions): string {
  switch (source.kind) {
    case "discord":
      return source.url;
    case "pr":
      return `https://github.com/${source.repo}/pull/${source.number}`;
    case "issue":
      return `https://github.com/${source.repo}/issues/${source.number}`;
    case "meeting":
    case "voice-memo":
    case "interview": {
      const ref = refOf(source, options);
      return `https://github.com/${source.repo}/blob/${ref}/${source.path}${lineAnchor(source.lines)}`;
    }
  }
}

// blob URL の ref は単一セグメント前提(commit SHA か "main" のような単純ブランチ名)。
// "release/v1" のようなスラッシュ入りブランチ名は repo/path 境界を一意復元できないため非対応。
// provenance は commit SHA permalink を主用途とするためこの制約で十分(逆変換は best-effort)。
const GH_BLOB_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/blob\/([^/]+)\/(.+?)(#L\d+(?:-L\d+)?)?$/;
const GH_PULL_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)$/;
const GH_ISSUE_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+)$/;

/** permalink 文字列 → Source。許可外ドメイン・不正構造は {@link KbProvenanceError}。 */
export function urlToSource(url: string): Source {
  const discord = DISCORD_PERMALINK_RE.exec(url);
  if (discord) return { kind: "discord", url };

  const pull = GH_PULL_RE.exec(url);
  if (pull) return { kind: "pr", repo: pull[1] as string, number: Number(pull[2]) };

  const issue = GH_ISSUE_RE.exec(url);
  if (issue) return { kind: "issue", repo: issue[1] as string, number: Number(issue[2]) };

  const blob = GH_BLOB_RE.exec(url);
  if (blob) {
    const [, repo, ref, path, anchor] = blob;
    const source: Source = { kind: "meeting", repo: repo as string, path: path as string, ref };
    if (anchor) source.lines = anchor.slice(1); // 先頭の "#" を除く
    return source;
  }

  throw new KbProvenanceError(
    `許可された permalink ではありません(github.com / discord.com のみ): ${url}`,
  );
}

/** "L120-L141" → { start: 120, end: 141 }。"L120" → { start: 120, end: 120 }。 */
export function parseLineRange(lines: string): { start: number; end: number } {
  const m = LINE_RANGE_RE.exec(lines);
  if (!m) throw new KbProvenanceError(`lines の形式が不正です: ${lines}`);
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1 || end < start) {
    throw new KbProvenanceError(`lines の範囲が不正です: ${lines}`);
  }
  return { start, end };
}
