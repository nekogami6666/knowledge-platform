/**
 * KB clone に既出の discord permalink 索引(ADR-0033 D4 デデュープ③)。
 * knowledge/ decisions/ questions/ を 1 パスして本文中の permalink を集め、既知 URL のメッセージを
 * **LLM 呼び出し前に** 落とす(💡 capture・gap 回答・過去の discord 抽出との重複防止)。
 * 走査は生テキストの正規表現で足りる(sources だけでなく本文中の言及も拾えて安全側)。
 */
import { join } from "node:path";

const PERMALINK_RE = /https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g;
const SCAN_DIRS = ["knowledge", "decisions", "questions"] as const;

export interface PrefilterDeps {
  /** dir 配下の相対パス一覧(再帰・実装は fs.readdir recursive)。不在は [] を返すこと。 */
  listFiles(absDir: string): Promise<string[]>;
  readFile(absPath: string): Promise<string>;
}

export async function buildPermalinkIndex(
  kbRoot: string,
  deps: PrefilterDeps,
): Promise<Set<string>> {
  const known = new Set<string>();
  for (const dir of SCAN_DIRS) {
    const base = join(kbRoot, dir);
    for (const rel of await deps.listFiles(base)) {
      if (!rel.endsWith(".md")) continue;
      const raw = await deps.readFile(join(base, rel));
      for (const m of raw.match(PERMALINK_RE) ?? []) known.add(m);
    }
  }
  return known;
}
