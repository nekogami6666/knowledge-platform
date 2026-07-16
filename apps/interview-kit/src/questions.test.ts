import { describe, expect, it } from "vitest";
import {
  buildKitMarkdown,
  buildQuestionsPrompt,
  generateQuestions,
  kitPath,
  type QuestionKit,
  questionKitSchema,
  slugify,
} from "./questions.js";

const KIT: QuestionKit = {
  intro: "hardware domain は手順書が薄い。初期化と故障対応の穴を埋める。",
  questions: [
    { question: "ゼロから立ち上げる手順は?", aim: "初期化シーケンスの文書化" },
    { question: "一番よくある故障は?", aim: "故障モードの文書化" },
    { question: "ベンダー固有の癖は?", aim: "暗黙の前提の文書化" },
    { question: "引き継ぎで最初に教えることは?", aim: "引き継ぎ知識" },
    { question: "A/B で迷ったときの判断基準は?", aim: "判断基準の文書化" },
  ],
};

describe("questionKitSchema", () => {
  it("5〜20 問を受け付け、範囲外は拒否する", () => {
    expect(questionKitSchema.safeParse(KIT).success).toBe(true);
    expect(questionKitSchema.safeParse({ ...KIT, questions: [] }).success).toBe(false);
    expect(
      questionKitSchema.safeParse({
        ...KIT,
        questions: Array.from({ length: 21 }, () => KIT.questions[0]),
      }).success,
    ).toBe(false);
  });
});

describe("buildQuestionsPrompt", () => {
  it("対象者・トピックと調査指示(knowledge/ expertise/ questions/ interviews/)を含む", () => {
    const p = buildQuestionsPrompt("yamada", "恒温槽の校正");
    expect(p).toContain("yamada");
    expect(p).toContain("恒温槽の校正");
    for (const dir of [
      "knowledge/",
      "expertise/expertise.yaml",
      "questions/open/",
      "interviews/",
    ]) {
      expect(p).toContain(dir);
    }
  });
});

describe("generateQuestions", () => {
  it("prompts/interview/questions.md を deep role で使い、agentic read(既定ツール)で呼ぶ", async () => {
    let captured: { role?: string; allowedTools?: readonly string[]; cwd?: string } = {};
    const names: string[] = [];
    const r = await generateQuestions("yamada", "topic", {
      promptStore: {
        read: async (app: string, name: string) => {
          names.push(`${app}/${name}`);
          return "---\nrole: deep\n---\nRULES";
        },
      },
      cwd: "/kb",
      search: async (opts) => {
        captured = opts;
        return { value: KIT, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    expect(r.value.questions).toHaveLength(5);
    expect(names).toContain("interview/questions");
    expect(captured.role).toBe("deep");
    expect(captured.cwd).toBe("/kb");
    // allowedTools を明示しない = 既定の Read/Grep/Glob(agentic read・§9.5)。
    expect(captured.allowedTools).toBeUndefined();
  });
});

describe("kitPath / slugify / buildKitMarkdown", () => {
  it("path はスラグ化される(日本語トピックはフォールバック)", () => {
    expect(kitPath("Yamada", "thermal chamber")).toBe("interviews/kits/yamada-thermal-chamber.md");
    expect(kitPath("yamada", "恒温槽")).toBe("interviews/kits/yamada-x.md");
    expect(slugify("---")).toBe("x");
  });
  it("Markdown に番号付き質問・ねらい・進め方を含む", () => {
    const md = buildKitMarkdown("yamada", "恒温槽の校正", KIT, "2026-07-16");
    expect(md).toContain("# インタビューキット: yamada × 恒温槽の校正");
    expect(md).toContain("1. **ゼロから立ち上げる手順は?**");
    expect(md).toContain("- ねらい: 初期化シーケンスの文書化");
    expect(md).toContain("5. **A/B で迷ったときの判断基準は?**");
    expect(md).toContain("進め方");
    expect(md).toContain("2026-07-16");
  });
});
