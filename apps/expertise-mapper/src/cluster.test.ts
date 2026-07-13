import type { PromptStore } from "@stratum/llm";
import { describe, expect, it, vi } from "vitest";
import {
  buildClusterPrompt,
  type ClusteringResult,
  type ClusterSearchFn,
  runClustering,
  type TopicRef,
  validateClustering,
} from "./cluster.js";
import type { TopicMaterial } from "./evidence.js";

const MATERIALS: TopicMaterial[] = [
  { id: "kb:kb-2026-0001", kind: "kb-entry", title: "湿度対策", domain: "hardware", tags: ["x"] },
  { id: "repo:o/fw", kind: "repo", repo: "o/fw" },
];
const EXISTING: TopicRef[] = [{ topic: "dispenser-x-firmware", label: "分注 X FW" }];
const promptStore: PromptStore = {
  read: async () => "---\nrole: deep\n---\n分類器の system prompt",
};

const ok: ClusteringResult = {
  assignments: [
    { material_id: "kb:kb-2026-0001", topic: "dispenser-x-firmware" },
    { material_id: "repo:o/fw", topic: "dispenser-x-firmware" },
  ],
  new_topics: [],
};

function fakeSearch(results: ClusteringResult[]): {
  search: ClusterSearchFn;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const search: ClusterSearchFn = async (opts) => {
    calls.push(opts.prompt);
    const value = results[Math.min(i, results.length - 1)] as ClusteringResult;
    i += 1;
    return { value, usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return { search, calls };
}

describe("buildClusterPrompt(決定的・数値を渡さない)", () => {
  it("既存トピックと material を昇順の柵で並べる", () => {
    const p = buildClusterPrompt(EXISTING, MATERIALS);
    expect(p).toContain("- dispenser-x-firmware(分注 X FW)");
    expect(p).toContain("- kb:kb-2026-0001 [KB] 湿度対策 / domain: hardware / tags: x");
    expect(p).toContain("- repo:o/fw [repo] o/fw");
    expect(p).not.toMatch(/evidence|count|[0-9]+ 件/);
  });
});

describe("validateClustering(参照整合の後検証)", () => {
  const ids = new Set(MATERIALS.map((m) => m.id));
  it("正常な出力は問題なし", () => {
    expect(validateClustering(ok, ids, EXISTING)).toEqual([]);
  });
  it("既存 topic と衝突する new_topics(実質 rename)を遮断", () => {
    const bad: ClusteringResult = {
      assignments: [],
      new_topics: [{ topic: "dispenser-x-firmware", label: "改名の試み" }],
    };
    expect(validateClustering(bad, ids, EXISTING).join()).toMatch(/重複/);
  });
  it("未知 topic への割当・存在しない material・二重割当を検出", () => {
    const bad: ClusteringResult = {
      assignments: [
        { material_id: "kb:kb-2026-0001", topic: "ghost-topic" },
        { material_id: "kb:missing", topic: "dispenser-x-firmware" },
        { material_id: "kb:kb-2026-0001", topic: "dispenser-x-firmware" },
      ],
      new_topics: [],
    };
    const issues = validateClustering(bad, ids, EXISTING);
    expect(issues).toHaveLength(3);
  });
});

describe("runClustering(是正リトライ 1 回 → fail-loud)", () => {
  it("初回 OK: 割当・label 引き継ぎ・未割当の列挙", async () => {
    const { search, calls } = fakeSearch([
      {
        assignments: [{ material_id: "kb:kb-2026-0001", topic: "assay-protocol" }],
        new_topics: [{ topic: "assay-protocol", label: "アッセイ手順" }],
      },
    ]);
    const { value } = await runClustering(EXISTING, MATERIALS, {
      promptStore,
      search,
      cwd: "/kb",
    });
    expect(calls).toHaveLength(1);
    expect(value.assignments.get("kb:kb-2026-0001")).toBe("assay-protocol");
    expect(value.topicLabels.get("dispenser-x-firmware")).toBe("分注 X FW"); // 既存 label は必ず残る
    expect(value.topicLabels.get("assay-protocol")).toBe("アッセイ手順");
    expect(value.unassigned).toEqual(["repo:o/fw"]);
  });

  it("違反 → 是正フィードバック付きで 1 回だけ再試行して成功", async () => {
    const bad: ClusteringResult = {
      assignments: [{ material_id: "kb:kb-2026-0001", topic: "ghost" }],
      new_topics: [],
    };
    const { search, calls } = fakeSearch([bad, ok]);
    const { value, usage } = await runClustering(EXISTING, MATERIALS, {
      promptStore,
      search,
      cwd: "/kb",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("前回出力の問題");
    expect(value.assignments.size).toBe(2);
    expect(usage.inputTokens).toBe(20); // 2 回分を合算
  });

  it("再試行後も違反なら throw(部分出力で汚さない)", async () => {
    const bad: ClusteringResult = {
      assignments: [{ material_id: "kb:missing", topic: "dispenser-x-firmware" }],
      new_topics: [],
    };
    const { search } = fakeSearch([bad, bad]);
    await expect(
      runClustering(EXISTING, MATERIALS, { promptStore, search, cwd: "/kb" }),
    ).rejects.toThrow(/検証に失敗/);
  });
});
