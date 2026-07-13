import { describe, expect, it } from "vitest";
import { laterDate, type MaterialEvidence, mergeEvidence } from "./evidence.js";

const m = (id: string, people: { person: string; count?: number }[]): MaterialEvidence => ({
  material: { id, kind: "repo", repo: id.replace("repo:", "") },
  people: people.map((p) => ({ person: p.person, count: p.count ?? 1, lastActive: "2026-07-01" })),
});

describe("mergeEvidence(決定的な統合・ADR-0017 D6 の前提)", () => {
  it("materials を id 昇順・people を person 昇順に正規化する", () => {
    const pool = mergeEvidence([
      [m("repo:o/b", [{ person: "z" }, { person: "a" }])],
      [m("repo:o/a", [{ person: "y" }])],
    ]);
    expect(pool.materials.map((x) => x.material.id)).toEqual(["repo:o/a", "repo:o/b"]);
    expect(pool.materials[1]?.people.map((p) => p.person)).toEqual(["a", "z"]);
  });

  it("material.id の重複はコレクタのバグとして fail-loud", () => {
    expect(() =>
      mergeEvidence([[m("repo:o/a", [{ person: "x" }])], [m("repo:o/a", [{ person: "y" }])]]),
    ).toThrow(/重複/);
  });

  it("unattributedCommits を透過する", () => {
    const pool = mergeEvidence([], { "o/a": 3 });
    expect(pool.unattributedCommits).toEqual({ "o/a": 3 });
    expect(pool.materials).toEqual([]);
  });
});

describe("laterDate", () => {
  it("dateOnly の新しい方を返す", () => {
    expect(laterDate("2026-07-01", "2026-06-30")).toBe("2026-07-01");
    expect(laterDate("2026-06-30", "2026-07-01")).toBe("2026-07-01");
    expect(laterDate("2026-07-01", "2026-07-01")).toBe("2026-07-01");
  });
});
