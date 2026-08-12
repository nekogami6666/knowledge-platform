import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_INTERVAL_DAYS, ID_PREFIX_RE } from "./common.js";
import { decisionRecordSchema } from "./decision-record.js";
import { expertiseMapSchema } from "./expertise-map.js";
import { knowledgeEntrySchema } from "./knowledge-entry.js";
import { questionLogSchema } from "./question-log.js";
import { sourceSchema, sourcesSchema } from "./source.js";

/** 正常系の最小ナレッジエントリ(各テストで上書きして使う)。 */
function validKnowledge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "kb-2026-0142",
    title: "タイトル",
    type: "failure",
    domain: "hardware",
    sources: [{ kind: "discord", url: "https://discord.com/channels/1/2/3" }],
    confidence: "high",
    status: "active",
    created: "2026-06-10",
    last_verified: "2026-06-10",
    owner: "yamada",
    ...overrides,
  };
}

/** 最初の issue の path を取り出す(エラー品質のアサート用)。 */
function firstIssuePath(result: {
  success: false;
  error: { issues: { path: PropertyKey[] }[] };
}): string {
  return result.error.issues[0]!.path.join(".");
}

describe("knowledgeEntrySchema", () => {
  it("design.md §4.2 準拠の正常系を parse できる", () => {
    const parsed = knowledgeEntrySchema.parse(
      validKnowledge({
        tags: ["dispenser-x"],
        people: ["yamada", "suzuki"],
        supersedes: "kb-2026-0089",
      }),
    );
    expect(parsed.id).toBe("kb-2026-0142");
    expect(parsed.tags).toEqual(["dispenser-x"]);
  });

  it("verification_status / verified_by を受理する(ADR-0027 D4・v5)", () => {
    const parsed = knowledgeEntrySchema.parse(
      validKnowledge({ verification_status: "unverified" }),
    );
    expect(parsed.verification_status).toBe("unverified");
    const verified = knowledgeEntrySchema.parse(
      validKnowledge({ verification_status: "verified", verified_by: "yamada" }),
    );
    expect(verified.verified_by).toBe("yamada");
    // 省略 = legacy(既存エントリの後方互換)
    expect(knowledgeEntrySchema.parse(validKnowledge()).verification_status).toBeUndefined();
  });

  it("verification_status の enum 外を拒否する", () => {
    expect(
      knowledgeEntrySchema.safeParse(validKnowledge({ verification_status: "checked" })).success,
    ).toBe(false);
  });

  it("review_interval_days を type 別デフォルトで補完する", () => {
    expect(
      knowledgeEntrySchema.parse(validKnowledge({ type: "procedure" })).review_interval_days,
    ).toBe(90);
    expect(knowledgeEntrySchema.parse(validKnowledge({ type: "fact" })).review_interval_days).toBe(
      180,
    );
    expect(
      knowledgeEntrySchema.parse(validKnowledge({ type: "learning" })).review_interval_days,
    ).toBe(180);
    expect(
      knowledgeEntrySchema.parse(validKnowledge({ type: "failure" })).review_interval_days,
    ).toBe(365);
    // decision は鮮度確認対象外(null)
    expect(
      knowledgeEntrySchema.parse(validKnowledge({ type: "decision" })).review_interval_days,
    ).toBeNull();
  });

  it("明示指定した review_interval_days はデフォルトより優先される", () => {
    const parsed = knowledgeEntrySchema.parse(
      validKnowledge({ type: "fact", review_interval_days: 30 }),
    );
    expect(parsed.review_interval_days).toBe(30);
  });

  it("DEFAULT_REVIEW_INTERVAL_DAYS が全 type を網羅する", () => {
    expect(DEFAULT_REVIEW_INTERVAL_DAYS).toEqual({
      procedure: 90,
      fact: 180,
      learning: 180,
      failure: 365,
      decision: null,
    });
  });

  it("必須フィールド欠落(owner)を検出する", () => {
    const { owner, ...withoutOwner } = validKnowledge();
    const result = knowledgeEntrySchema.safeParse(withoutOwner);
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIssuePath(result)).toBe("owner");
  });

  it("不正な ID 形式を検出する", () => {
    for (const bad of [
      "kb-26-0142",
      "KB-2026-0142",
      "kb-2026-142",
      "dr-2026-0001",
      // 新形式(ADR-0026)の境界: 5文字・7文字・大文字・`-` 入り suffix は不正
      "kb-2026-a3f8x",
      "kb-2026-a3f8x7z",
      "kb-2026-A3F8X7",
      "kb-2026-a3-8x7",
    ]) {
      const result = knowledgeEntrySchema.safeParse(validKnowledge({ id: bad }));
      expect(result.success, bad).toBe(false);
    }
  });

  it("ランダム6文字の新 ID 形式(ADR-0026)を旧形式と併せて受理する", () => {
    // 新: base36 ちょうど6文字(全数字6文字も有効 = 長さで旧4桁と判別)
    for (const good of ["kb-2026-a3f8x7", "kb-2026-123456", "kb-2027-000abc"]) {
      expect(knowledgeEntrySchema.safeParse(validKnowledge({ id: good })).success, good).toBe(true);
    }
    // 旧: 4桁連番は恒久共存(既存49エントリ)
    expect(knowledgeEntrySchema.safeParse(validKnowledge({ id: "kb-2026-0142" })).success).toBe(
      true,
    );
  });

  it("ID_PREFIX_RE はファイル名から新旧 ID を正しく切り出す(全数字6文字を途中切りしない)", () => {
    const cases: [string, string][] = [
      ["kb-2026-0142-wiring-diagram.md", "kb-2026-0142"], // 旧4桁 + slug
      ["kb-2026-a3f8x7-allegro-specs.md", "kb-2026-a3f8x7"], // 新6文字 + slug
      ["kb-2026-123456-edge-case.md", "kb-2026-123456"], // 全数字6文字(選択順が \d{4} 先だと途中切りされる)
      ["dr-2026-0031-panel-material.md", "dr-2026-0031"],
      ["q-2026-b7c1zx.md", "q-2026-b7c1zx"],
    ];
    for (const [filename, expected] of cases) {
      expect(ID_PREFIX_RE.exec(filename)?.[0], filename).toBe(expected);
    }
  });

  it("enum 外の値(type / status / confidence)を検出する", () => {
    expect(knowledgeEntrySchema.safeParse(validKnowledge({ type: "bug" })).success).toBe(false);
    expect(knowledgeEntrySchema.safeParse(validKnowledge({ status: "draft" })).success).toBe(false);
    expect(knowledgeEntrySchema.safeParse(validKnowledge({ confidence: "maybe" })).success).toBe(
      false,
    );
  });

  it("型不一致(tags が文字列)を検出する", () => {
    const result = knowledgeEntrySchema.safeParse(validKnowledge({ tags: "dispenser-x" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIssuePath(result)).toBe("tags");
  });

  it("不正な日付(スラッシュ区切り・実在しない日)を検出する", () => {
    expect(knowledgeEntrySchema.safeParse(validKnowledge({ created: "2026/06/10" })).success).toBe(
      false,
    );
    expect(knowledgeEntrySchema.safeParse(validKnowledge({ created: "2026-02-30" })).success).toBe(
      false,
    );
  });

  it("未知フィールドを strict で拒否する", () => {
    const result = knowledgeEntrySchema.safeParse(validKnowledge({ statsu: "active" }));
    expect(result.success).toBe(false);
  });
});

describe("sourcesSchema / sourceSchema", () => {
  it("空配列を拒否する(P2)", () => {
    const result = sourcesSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("種別ごとの正常系を parse できる", () => {
    expect(
      sourceSchema.safeParse({ kind: "meeting", repo: "org/minutes", path: "a.md", lines: "L1-L9" })
        .success,
    ).toBe(true);
    expect(sourceSchema.safeParse({ kind: "pr", repo: "org/app", number: 12 }).success).toBe(true);
    expect(sourceSchema.safeParse({ kind: "issue", repo: "org/app", number: 7 }).success).toBe(
      true,
    );
    expect(
      sourceSchema.safeParse({ kind: "voice-memo", repo: "org/kb", path: "v.md", ref: "abc" })
        .success,
    ).toBe(true);
    expect(
      sourceSchema.safeParse({ kind: "interview", repo: "org/kb", path: "i.md" }).success,
    ).toBe(true);
    expect(
      sourceSchema.safeParse({ kind: "discord", url: "https://discord.com/channels/1/2/3" })
        .success,
    ).toBe(true);
  });

  it("kind 不正値を拒否する", () => {
    expect(sourceSchema.safeParse({ kind: "slack", url: "https://x" }).success).toBe(false);
  });

  it("discord source の url 欠落を拒否する", () => {
    expect(sourceSchema.safeParse({ kind: "discord" }).success).toBe(false);
  });

  it("meeting source の path 欠落を拒否する", () => {
    expect(sourceSchema.safeParse({ kind: "meeting", repo: "org/minutes" }).success).toBe(false);
  });

  it("lines 形式不正・逆転レンジを拒否する", () => {
    expect(
      sourceSchema.safeParse({ kind: "meeting", repo: "org/m", path: "a.md", lines: "120-141" })
        .success,
    ).toBe(false);
    expect(
      sourceSchema.safeParse({ kind: "meeting", repo: "org/m", path: "a.md", lines: "L141-L120" })
        .success,
    ).toBe(false);
  });

  it("repo 形式不正を拒否する", () => {
    expect(sourceSchema.safeParse({ kind: "pr", repo: "no-slash", number: 1 }).success).toBe(false);
  });

  it("pr source の不正な number(0・負数)を拒否する", () => {
    expect(sourceSchema.safeParse({ kind: "pr", repo: "org/a", number: 0 }).success).toBe(false);
    expect(sourceSchema.safeParse({ kind: "pr", repo: "org/a", number: -1 }).success).toBe(false);
  });

  it("pr / issue source は ref を持たない(strict)", () => {
    expect(
      sourceSchema.safeParse({ kind: "pr", repo: "org/a", number: 1, ref: "abc" }).success,
    ).toBe(false);
  });

  it("discord source に余分なフィールドを許さない(strict)", () => {
    expect(
      sourceSchema.safeParse({
        kind: "discord",
        url: "https://discord.com/channels/1/2/3",
        repo: "org/a",
      }).success,
    ).toBe(false);
  });
});

describe("decisionRecordSchema", () => {
  const valid = {
    id: "dr-2026-0031",
    title: "決定",
    date: "2026-06-03",
    status: "accepted",
    deciders: ["yamada"],
    sources: [{ kind: "meeting", repo: "org/minutes", path: "a.md" }],
  };

  it("正常系を parse できる", () => {
    expect(decisionRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("dr- 以外の ID を拒否する", () => {
    expect(decisionRecordSchema.safeParse({ ...valid, id: "kb-2026-0031" }).success).toBe(false);
  });

  it("deciders 空配列を拒否する", () => {
    expect(decisionRecordSchema.safeParse({ ...valid, deciders: [] }).success).toBe(false);
  });

  it("status enum 外を拒否する", () => {
    expect(decisionRecordSchema.safeParse({ ...valid, status: "active" }).success).toBe(false);
  });

  it("supersedes(dr-ID)を受理し、dr- 以外を拒否する(ADR-0027 D4・v5)", () => {
    expect(decisionRecordSchema.safeParse({ ...valid, supersedes: "dr-2026-0001" }).success).toBe(
      true,
    );
    expect(decisionRecordSchema.safeParse({ ...valid, supersedes: "kb-2026-0001" }).success).toBe(
      false,
    );
  });
});

describe("questionLogSchema", () => {
  const valid = {
    id: "q-2026-0088",
    asked_by: "tanaka",
    asked_at: "2026-06-09T14:22:00+09:00",
    channel: "dev-hw",
    question: "?",
    bot_answer_quality: "unanswered",
    status: "open",
  };

  it("正常系を parse できる", () => {
    expect(questionLogSchema.safeParse(valid).success).toBe(true);
  });

  it("オフセットなしの asked_at を拒否する", () => {
    expect(questionLogSchema.safeParse({ ...valid, asked_at: "2026-06-09T14:22:00" }).success).toBe(
      false,
    );
  });

  it("bot_answer_quality enum 外を拒否する", () => {
    expect(questionLogSchema.safeParse({ ...valid, bot_answer_quality: "ok" }).success).toBe(false);
  });

  it("resulting_kb は kb- ID でなければ拒否する", () => {
    expect(questionLogSchema.safeParse({ ...valid, resulting_kb: "q-2026-0001" }).success).toBe(
      false,
    );
  });
});

describe("expertiseMapSchema", () => {
  const valid = {
    generated_at: "2026-06-08T03:00:00+09:00",
    topics: [
      {
        topic: "t",
        label: "ラベル",
        people: [{ name: "yamada", evidence_count: 23, last_active: "2026-06-05" }],
        bus_factor: 1,
        documented_kb_count: 2,
        risk: "high",
      },
    ],
  };

  it("正常系を parse できる", () => {
    expect(expertiseMapSchema.safeParse(valid).success).toBe(true);
  });

  it("evidence_count が文字列なら拒否する", () => {
    const broken = structuredClone(valid);
    (broken.topics[0]!.people[0] as Record<string, unknown>).evidence_count = "twenty";
    expect(expertiseMapSchema.safeParse(broken).success).toBe(false);
  });

  it("bus_factor が負数なら拒否する", () => {
    const broken = structuredClone(valid);
    broken.topics[0]!.bus_factor = -1;
    expect(expertiseMapSchema.safeParse(broken).success).toBe(false);
  });
});
