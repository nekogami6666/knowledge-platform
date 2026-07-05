/**
 * 既存 domain の再利用支援(⑱・レビュー §1-B/§2-C)。domain 乱立を「予防+検出」の二段構えで抑える。
 * - listDomains: knowledge-base clone の `knowledge/<domain>/` 直下ディレクトリ名を列挙(純関数・readdir 注入)。
 *   extract プロンプトへ「既存 domain」として渡し、モデルに再利用を促す(予防)。
 * - checkDomainProximity: 新設 domain 名が既存名と正規化一致/包含かを判定(検出)。ヒットは警告として
 *   run サマリ/PR body に出し、人間が PR で folder rename して集約する(自動 fold はしない=誤統合回避)。
 */
import { join } from "node:path";

/** node:fs/promises readdir(withFileTypes)の最小契約(seam。テストは fake で鍵/実 fs 不要)。 */
export type ReaddirFn = (
  dir: string,
) => Promise<readonly { name: string; isDirectory(): boolean }[]>;

/** knowledge/<domain>/ の domain 一覧。先頭 `_`/`.` のディレクトリは除外(_templates・隠しディレクトリ対策)。 */
export async function listDomains(kbRoot: string, readdir: ReaddirFn): Promise<string[]> {
  let entries: readonly { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(join(kbRoot, "knowledge"));
  } catch {
    return []; // knowledge/ が無い KB(初回等)は空
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** 正規化(小文字化・非英数除去)。`hardware-verification` と `hardware` を比較可能にする。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * domain が existing のどれかと近接(正規化での包含)なら、その既存名を返す。
 * 完全一致(=既存の再利用)は近接ではないので null。短い部分文字列(<4)は誤検出防止のため無視する
 * (例: `ai` ⊄ `email` 扱いしない)。近接判定はあくまで警告用(自動統合はしない)。
 */
export function checkDomainProximity(domain: string, existing: readonly string[]): string | null {
  const d = normalize(domain);
  if (d.length === 0) return null;
  for (const e of existing) {
    const n = normalize(e);
    if (n.length === 0 || n === d) continue; // 完全一致は再利用であって近接ではない
    const shorter = Math.min(d.length, n.length);
    if (shorter >= 4 && (d.includes(n) || n.includes(d))) return e;
  }
  return null;
}
