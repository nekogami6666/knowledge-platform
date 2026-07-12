import type { ExtractionResult } from "@stratum/extractor/candidate";
import type { AgentSearchOptions } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import { buildPrExtractPrompt, extractFromPr, type PrInput } from "./extract.js";

const promptStore = { read: async () => "---\nrole: standard\n---\nRULES" };

const input: PrInput = {
  repo: "org/dev",
  number: 42,
  title: "gh-client に PR 読み取り API を追加",
  body: "OctokitLike を optional で拡張して既存 fake を壊さないようにした。",
  author: "yamada",
  comments: [
    {
      kind: "review",
      author: "sato",
      body: "ページングの early-exit は健全?",
      createdAt: "t1",
      path: "client.ts",
    },
    { kind: "issue", author: "yamada", body: "merged_at ≤ updated_at なので OK", createdAt: "t2" },
  ],
  files: [
    { path: "packages/gh-client/src/client.ts", status: "modified", additions: 200, deletions: 5 },
  ],
};

describe("buildPrExtractPrompt", () => {
  it("本文・コメント(投稿者付き)・ファイルサマリを含み、diff は含まない", () => {
    const p = buildPrExtractPrompt(input, ["gh-client"]);
    expect(p).toContain("#42");
    expect(p).toContain("OctokitLike");
    expect(p).toContain("[sato]");
    expect(p).toContain("packages/gh-client/src/client.ts(modified +200 -5)");
    expect(p).toContain("既存 domain");
    // patch/diff 本文は素材に無い(§6.4 ③-c)
    expect(p).not.toContain("@@");
  });

  it("巨大な本文は上限で切り詰める", () => {
    const big = { ...input, body: "x".repeat(20_000) };
    const p = buildPrExtractPrompt(big);
    expect(p.length).toBeLessThan(20_000);
    expect(p).toContain("…");
  });
});

describe("extractFromPr", () => {
  it("app=pr-miner・ツール無し単発で extractor の器を再利用する", async () => {
    let captured: AgentSearchOptions<ExtractionResult> | undefined;
    const empty: ExtractionResult = { decisions: [], learnings: [], openQuestions: [] };
    const r = await extractFromPr(input, {
      promptStore,
      cwd: "/kb",
      existingDomains: ["gh-client"],
      search: async (opts) => {
        captured = opts;
        return { value: empty, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    expect(r.value).toEqual(empty);
    expect(captured?.app).toBe("pr-miner");
    expect(captured?.allowedTools).toEqual([]);
    expect(captured?.cwd).toBe("/kb");
    expect(captured?.prompt).toContain("gh-client"); // existingDomains が渡る
  });
});
