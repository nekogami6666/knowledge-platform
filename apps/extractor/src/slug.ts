/**
 * エントリファイル名のスラグ生成(`<id>-<slug>.md`)。日本語タイトルは ASCII 化で空になりうるため、
 * 空なら "entry" にフォールバックする(validateRepo は `<id>-` 接頭辞のみ検証。slug は任意の識別子)。
 * LLM が候補に ASCII `slug` を付けていればそれを優先し、無ければタイトルから生成する。
 */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s.length > 0 ? s : "entry";
}
