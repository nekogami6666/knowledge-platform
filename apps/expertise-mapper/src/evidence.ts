/**
 * evidence の中間データモデル(design.md §6.6 ⑤-a / ADR-0017 D2・D6)。
 *
 * クラスタリングの単位は「人」ではなく **material(トピック材料)**:
 * KB エントリ(1 エントリ = 1 material)と対象リポ(1 リポ = 1 material)。
 * material → topic の割当が決まれば人の指標(evidence_count / bus_factor / risk)は
 * すべてコードで決定的に導出できるため、LLM の入出力から人名・数値を完全に排除できる。
 *
 * v1 の evidence は KB(owner/people/deciders)+ commit(GitHub API の author login)の
 * 2 ソースのみ — どちらも初めから GitHub ユーザ名なので members 対応表が空でも成立する。
 */

/** クラスタリングされる単位。id は "kb:<エントリID>" / "repo:<org/name>"。 */
export type TopicMaterial =
  | {
      id: string;
      kind: "kb-entry";
      title: string;
      /** decisions は domain を持たない(スキーマ差)。 */
      domain?: string;
      tags: readonly string[];
    }
  | { id: string; kind: "repo"; repo: string };

/** material 上の人別集計(person は GitHub ユーザ名)。 */
export interface PersonActivity {
  person: string;
  /** kb-entry: 関与 = 1 / repo: 期間内の commit 数。 */
  count: number;
  /** 最終活動日(YYYY-MM-DD)。 */
  lastActive: string;
}

export interface MaterialEvidence {
  material: TopicMaterial;
  /** person 一意(コレクタが保証)。 */
  people: readonly PersonActivity[];
}

export interface EvidencePool {
  /** material.id 昇順(プロンプト・指標の決定性のため)。 */
  materials: readonly MaterialEvidence[];
  /** author login が引けなかった commit 数(リポ別)。silent drop せずレポートに列挙する(D2)。 */
  unattributedCommits: Readonly<Record<string, number>>;
}

/**
 * コレクタ出力を統合して決定的な順序に正規化する。
 * material.id 昇順・material 内の people は person 昇順。id 重複はコレクタのバグなので fail-loud。
 */
export function mergeEvidence(
  parts: readonly (readonly MaterialEvidence[])[],
  unattributedCommits: Readonly<Record<string, number>> = {},
): EvidencePool {
  const all = parts.flat();
  const seen = new Set<string>();
  for (const m of all) {
    if (seen.has(m.material.id)) {
      throw new Error(`material.id が重複しています(コレクタのバグ): ${m.material.id}`);
    }
    seen.add(m.material.id);
  }
  const materials = all
    .map((m) => ({
      material: m.material,
      people: [...m.people].sort((a, b) => a.person.localeCompare(b.person)),
    }))
    .sort((a, b) => a.material.id.localeCompare(b.material.id));
  return { materials, unattributedCommits };
}

/** 2 つの dateOnly(YYYY-MM-DD)の新しい方。 */
export function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}
