import { serializeExpertiseMap } from "@stratum/kb-core";
import { describe, expect, it, vi } from "vitest";
import type { ClusteringResult } from "./cluster.js";
import type { ExpertiseMapperConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { type RunDeps, runExpertiseMapper } from "./run.js";

const NOW = new Date("2026-07-19T17:30:00Z"); // JST 2026-07-20 02:30(月曜深夜)

const KNOWLEDGE = `---
id: kb-2026-0142
title: 分注ユニット X の湿度対策
type: fact
domain: hardware
tags: ["dispenser-x"]
sources:
  - kind: discord
    url: "https://discord.com/channels/1/2/3"
confidence: high
status: active
created: "2026-06-10"
last_verified: "2026-07-01"
owner: yamada
---

本文
`;

const config: ExpertiseMapperConfig = {
  targets: ["o/fw"],
  kb: { repo: "org/knowledge-base" },
  base_branch: "main",
  window_days: 90,
};

const clusterOk: ClusteringResult = {
  assignments: [
    { material_id: "kb:kb-2026-0142", topic: "dispenser-x-firmware" },
    { material_id: "repo:o/fw", topic: "dispenser-x-firmware" },
  ],
  new_topics: [{ topic: "dispenser-x-firmware", label: "分注 X FW" }],
};

function makeDeps(over: Partial<RunDeps> = {}): {
  deps: RunDeps;
  written: Record<string, string>;
  gh: { commitFiles: ReturnType<typeof vi.fn> };
  notified: unknown[];
} {
  const written: Record<string, string> = {};
  const fsFiles: Record<string, string> = {
    "/kb/knowledge/hardware/kb-2026-0142-x.md": KNOWLEDGE,
  };
  const gh = { commitFiles: vi.fn(async () => ({ sha: "COMMITSHA" })) };
  const notified: unknown[] = [];
  const deps: RunDeps = {
    config,
    kbRoot: "/kb",
    gh,
    ghRead: {
      listCommits: vi.fn(async () => [
        { sha: "c1", author: "yamada", authoredAt: "2026-07-05T10:00:00Z" },
      ]),
    },
    clusterDeps: {
      promptStore: { read: async () => "---\nrole: deep\n---\n分類器" },
      search: async () => ({ value: clusterOk, usage: { inputTokens: 1, outputTokens: 1 } }),
    },
    readFile: async (p) => {
      const v = fsFiles[p] ?? written[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, content) => {
      written[p] = content;
    },
    readdir: async (dir) => {
      if (dir === "/kb/knowledge") return ["hardware/kb-2026-0142-x.md"];
      return [];
    },
    validate: async () => ({ ok: true, problems: [] }),
    notifier: {
      notifyHighRisk: async (items, reportPath) => {
        notified.push({ items, reportPath });
      },
    },
    now: () => NOW,
    logger: createLogger([], () => {}),
    real: true,
    ...over,
  };
  return { deps, written, gh, notified };
}

describe("runExpertiseMapper(§6.6 ⑤-a / ADR-0017 D5)", () => {
  it("happy path(real): yaml + 当日レポートを validateRepo 通過後に main 直 commit し、high を通知", async () => {
    const { deps, gh, notified, written } = makeDeps();
    const summary = await runExpertiseMapper(deps);

    expect(summary).toMatchObject({ committed: true, reason: "committed", topics: 1, highRisk: 1 });
    const call = gh.commitFiles.mock.calls[0]?.[0] as {
      repo: string;
      branch: string;
      files: { path: string }[];
    };
    expect(call.repo).toBe("org/knowledge-base");
    expect(call.branch).toBe("main");
    expect(call.files.map((f) => f.path).sort()).toEqual([
      "expertise/expertise.yaml",
      "expertise/reports/2026-07-20.md", // JST 日付(UTC だと 07-19)
    ]);
    // checkout にも実書きされている(validateRepo がディスクを読むため)
    expect(written["/kb/expertise/expertise.yaml"]).toContain("dispenser-x-firmware");
    expect(written["/kb/expertise/reports/2026-07-20.md"]).toContain("risk: high");
    // yamada が KB(1)+ commit(1)= 2 evidence・bus_factor 1・doc 1 < 5 → high 通知
    expect(notified).toHaveLength(1);
  });

  it("no-change: 内容が同一 + 当日レポート済みなら gh を呼ばない(再実行安全)", async () => {
    const first = makeDeps();
    await runExpertiseMapper(first.deps);
    const prevYaml = first.written["/kb/expertise/expertise.yaml"] as string;
    const prevReport = first.written["/kb/expertise/reports/2026-07-20.md"] as string;

    const second = makeDeps({
      clusterDeps: {
        promptStore: { read: async () => "---\nrole: deep\n---\n分類器" },
        // 2 回目は既存トピックを再利用する(new_topics を出さない)— 検証が正しく通る形
        search: async () => ({
          value: { assignments: clusterOk.assignments, new_topics: [] },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    });
    // 前回の生成物を fixture として注入
    const files: Record<string, string> = {
      "/kb/knowledge/hardware/kb-2026-0142-x.md": KNOWLEDGE,
      "/kb/expertise/expertise.yaml": prevYaml,
      "/kb/expertise/reports/2026-07-20.md": prevReport,
    };
    second.deps.readFile = async (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    };
    const summary = await runExpertiseMapper(second.deps);
    expect(summary.reason).toBe("no-change");
    expect(second.gh.commitFiles).not.toHaveBeenCalled();
  });

  it("dry-run(既定): 実書き + validate はするが commit しない", async () => {
    const { deps, gh, written } = makeDeps({ real: false });
    const summary = await runExpertiseMapper(deps);
    expect(summary.reason).toBe("dry-run");
    expect(gh.commitFiles).not.toHaveBeenCalled();
    expect(written["/kb/expertise/expertise.yaml"]).toBeDefined();
  });

  it("validateRepo 赤なら commit しない(ADR-0004 D2)", async () => {
    const { deps, gh } = makeDeps({ validate: async () => ({ ok: false, problems: [{}] }) });
    const summary = await runExpertiseMapper(deps);
    expect(summary.reason).toBe("validate-failed");
    expect(gh.commitFiles).not.toHaveBeenCalled();
  });

  it("targets 空: commit コレクタをスキップし KB evidence 単独で動く", async () => {
    const listCommits = vi.fn();
    const { deps } = makeDeps({
      config: { ...config, targets: [] },
      ghRead: { listCommits },
      clusterDeps: {
        promptStore: { read: async () => "---\nrole: deep\n---\n分類器" },
        search: async () => ({
          value: {
            assignments: [{ material_id: "kb:kb-2026-0142", topic: "dispenser-x-firmware" }],
            new_topics: [{ topic: "dispenser-x-firmware", label: "分注 X FW" }],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    });
    const summary = await runExpertiseMapper(deps);
    expect(listCommits).not.toHaveBeenCalled();
    expect(summary.topics).toBe(1);
  });

  it("material ゼロなら LLM を呼ばず終了", async () => {
    const search = vi.fn();
    const { deps } = makeDeps({
      config: { ...config, targets: [] },
      readdir: async () => [],
      clusterDeps: { promptStore: { read: async () => "x" }, search },
    });
    const summary = await runExpertiseMapper(deps);
    expect(summary.reason).toBe("no-materials");
    expect(search).not.toHaveBeenCalled();
  });

  it("既存 expertise.yaml が壊れていたら fail-loud(黙って上書きしない)", async () => {
    const { deps } = makeDeps();
    const orig = deps.readFile;
    deps.readFile = async (p) =>
      p === "/kb/expertise/expertise.yaml" ? "generated_at: broken\ntopics: []" : orig(p);
    await expect(runExpertiseMapper(deps)).rejects.toThrow();
  });

  it("2 回目の実行で既存トピックが増分入力される(名前安定の配線確認)", async () => {
    const prevYaml = serializeExpertiseMap({
      generated_at: "2026-07-13T02:00:00+09:00",
      topics: [
        {
          topic: "dispenser-x-firmware",
          label: "分注 X FW",
          people: [{ name: "yamada", evidence_count: 2, last_active: "2026-07-05" }],
          bus_factor: 1,
          documented_kb_count: 1,
          risk: "high",
        },
      ],
    });
    let captured = "";
    const { deps } = makeDeps({
      clusterDeps: {
        promptStore: { read: async () => "---\nrole: deep\n---\n分類器" },
        search: async (opts) => {
          captured = opts.prompt;
          return {
            value: { assignments: clusterOk.assignments, new_topics: [] },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    const orig = deps.readFile;
    deps.readFile = async (p) => (p === "/kb/expertise/expertise.yaml" ? prevYaml : orig(p));
    await runExpertiseMapper(deps);
    expect(captured).toContain("- dispenser-x-firmware(分注 X FW)"); // 既存トピックが入力に載る
  });
});
