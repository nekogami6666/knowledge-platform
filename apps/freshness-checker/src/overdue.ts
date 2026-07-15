/**
 * 期限超過エントリの列挙(design.md §6.7 / ADR-0019 D1)。純関数 — ファイル読みは呼び手。
 * 対象は knowledge/ 配下のみ(decisions/ は last_verified を持たず鮮度確認の対象外・§4.2)。
 * knowledge/ 内でも type: decision は review_interval_days が null になるため対象外。
 */
import { type KnowledgeEntry, safeParseEntry } from "@stratum/kb-core";
import type { Logger } from "./logger.js";

/** KB clone から読んだ 1 ファイル(path は KB リポ相対)。 */
export interface KbFile {
  path: string;
  raw: string;
}

export interface OverdueEntry {
  path: string;
  entry: KnowledgeEntry;
  /** last_verified + review_interval_days(YYYY-MM-DD)。 */
  dueDate: string;
}

/** 次回確認期限。review_interval_days が null(decision)は対象外なので null。 */
export function dueDateOf(entry: KnowledgeEntry): string | null {
  if (entry.review_interval_days === null) return null;
  const base = new Date(`${entry.last_verified}T00:00:00Z`);
  const due = new Date(base.getTime() + entry.review_interval_days * 86_400_000);
  return due.toISOString().slice(0, 10);
}

/**
 * status: active かつ期限(dueDate < todayJst)を過ぎたエントリを、期限の古い順で返す。
 * parse 不能ファイルは warn してスキップ(壊れた 1 件で全体を止めない。validate は CI の責務)。
 */
export function collectOverdue(
  files: readonly KbFile[],
  todayJst: string,
  logger: Logger,
): OverdueEntry[] {
  const out: OverdueEntry[] = [];
  for (const f of files) {
    const parsed = safeParseEntry(f.raw, "knowledge", f.path);
    if (!parsed.ok) {
      logger.warn("parse できないため鮮度確認をスキップ", { path: f.path });
      continue;
    }
    const entry = parsed.entry.frontmatter;
    if (entry.status !== "active") continue;
    const dueDate = dueDateOf(entry);
    if (dueDate === null || dueDate >= todayJst) continue;
    out.push({ path: f.path, entry, dueDate });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
