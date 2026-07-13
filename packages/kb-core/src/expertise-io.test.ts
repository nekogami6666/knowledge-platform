import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KbParseError } from "./errors.js";
import { parseExpertiseMap, sameExpertiseContent, serializeExpertiseMap } from "./expertise-io.js";
import type { ExpertiseMap } from "./schemas/expertise-map.js";

const MAP: ExpertiseMap = {
  generated_at: "2026-07-14T02:00:00+09:00",
  topics: [
    {
      topic: "dispenser-x-firmware",
      label: "分注ユニット X ファームウェア",
      people: [
        { name: "suzuki", evidence_count: 3, last_active: "2026-06-01" },
        { name: "yamada", evidence_count: 23, last_active: "2026-07-05" },
      ],
      bus_factor: 1,
      documented_kb_count: 2,
      risk: "high",
    },
    {
      topic: "assay-protocol",
      label: "アッセイ手順",
      people: [{ name: "tanaka", evidence_count: 5, last_active: "2026-07-01" }],
      bus_factor: 1,
      documented_kb_count: 7,
      risk: "medium",
    },
  ],
};

describe("serializeExpertiseMap(決定的シリアライズ・ADR-0017 D5)", () => {
  it("topics は topic 昇順・people は evidence_count 降順 → name 昇順に正規化される", () => {
    const yamlText = serializeExpertiseMap(MAP);
    const reparsed = parseExpertiseMap(yamlText);
    expect(reparsed.topics.map((t) => t.topic)).toEqual(["assay-protocol", "dispenser-x-firmware"]);
    expect(reparsed.topics[1]?.people.map((p) => p.name)).toEqual(["yamada", "suzuki"]);
  });

  it("順序が違うだけの同内容は同一文字列になる(週次 diff の安定)", () => {
    const shuffled: ExpertiseMap = {
      generated_at: MAP.generated_at,
      topics: [...MAP.topics].reverse().map((t) => ({ ...t, people: [...t.people].reverse() })),
    };
    expect(serializeExpertiseMap(shuffled)).toBe(serializeExpertiseMap(MAP));
  });

  it("round-trip: serialize → parse で内容が保たれる", () => {
    const reparsed = parseExpertiseMap(serializeExpertiseMap(MAP));
    expect(sameExpertiseContent(reparsed, MAP)).toBe(true);
    expect(reparsed.generated_at).toBe(MAP.generated_at);
  });

  it("不正データはファイル化前に SCHEMA_VIOLATION で止まる(§6.1)", () => {
    const bad = { ...MAP, topics: [{ ...MAP.topics[0], people: [] }] } as unknown as ExpertiseMap;
    expect(() => serializeExpertiseMap(bad)).toThrow(KbParseError);
  });
});

describe("sameExpertiseContent(generated_at 除外の内容比較)", () => {
  it("generated_at だけ違うなら同一", () => {
    expect(sameExpertiseContent(MAP, { ...MAP, generated_at: "2026-07-21T02:00:00+09:00" })).toBe(
      true,
    );
  });

  it("evidence_count の変化は別内容", () => {
    const changed: ExpertiseMap = {
      ...MAP,
      topics: MAP.topics.map((t, i) =>
        i === 0
          ? { ...t, people: t.people.map((p) => ({ ...p, evidence_count: p.evidence_count + 1 })) }
          : t,
      ),
    };
    expect(sameExpertiseContent(MAP, changed)).toBe(false);
  });
});

describe("parseExpertiseMap", () => {
  it("fixture(valid-kb)の expertise.yaml を読める", async () => {
    const p = fileURLToPath(
      new URL("../fixtures/valid-kb/expertise/expertise.yaml", import.meta.url),
    );
    const m = parseExpertiseMap(await readFile(p, "utf8"), p);
    expect(m.topics.length).toBeGreaterThan(0);
  });

  it("YAML 構文エラーは INVALID_YAML・スキーマ違反は SCHEMA_VIOLATION", () => {
    try {
      parseExpertiseMap("topics:\n\t- : :\n");
      expect.unreachable();
    } catch (e) {
      expect((e as KbParseError).code).toBe("INVALID_YAML");
    }
    try {
      parseExpertiseMap("generated_at: x\ntopics: []\n");
      expect.unreachable();
    } catch (e) {
      expect((e as KbParseError).code).toBe("SCHEMA_VIOLATION");
    }
  });
});
