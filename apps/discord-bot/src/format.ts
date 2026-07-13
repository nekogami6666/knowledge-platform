/**
 * 回答 + 出典脚注の整形(design.md §6.2 / P2)。
 * permalink 生成は kb-core の sourceToUrl を再利用する(QaCitation → kb-core Source へ写像)。
 * github_file は commit SHA(resolvedCommit)を ref に持つため、行アンカー付き固定 permalink になる。
 */
import { sourceToUrl } from "@stratum/kb-core";
import type { ResolvedCitation } from "./ask.js";

/** 検証済み引用 → permalink。kb-core の Source 形へ写して sourceToUrl に委ねる。 */
export function citationUrl(c: ResolvedCitation): string {
  switch (c.kind) {
    case "discord":
      return c.url;
    case "github_pr":
      return sourceToUrl({ kind: "pr", repo: c.repo, number: c.number });
    case "github_issue":
      return sourceToUrl({ kind: "issue", repo: c.repo, number: c.number });
    case "github_file":
      return sourceToUrl({
        kind: "meeting",
        repo: c.repo,
        path: c.path,
        ref: c.ref,
        ...(c.lines !== undefined ? { lines: c.lines } : {}),
      });
  }
}

/** stale な KB エントリを引用したときの注記(§6.7 / C8。除外せず注記付きで引用する)。 */
export const STALE_NOTE = "※最終確認から時間が経っています(stale)";

/** 回答本文に出典脚注を付す。引用が無ければ本文のみ(呼び出し側で notFound に倒す前提)。 */
export function formatAnswer(answer: string, citations: readonly ResolvedCitation[]): string {
  if (citations.length === 0) return answer;
  const notes = citations
    .map((c, i) => {
      const stale = c.kind === "github_file" && c.stale === true ? ` ${STALE_NOTE}` : "";
      return `[${i + 1}] ${citationUrl(c)}${stale}`;
    })
    .join("\n");
  return `${answer}\n\n出典:\n${notes}`;
}
