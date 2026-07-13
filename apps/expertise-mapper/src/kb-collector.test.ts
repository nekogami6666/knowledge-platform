import { describe, expect, it, vi } from "vitest";
import { collectKbEvidence } from "./kb-collector.js";

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
people: ["suzuki", "yamada"]
---

本文
`;

const DECISION = `---
id: dr-2026-0031
title: ファームは SWD 書き込みに統一
date: "2026-05-20"
status: accepted
deciders: ["yamada", "tanaka"]
sources:
  - kind: discord
    url: "https://discord.com/channels/1/2/4"
tags: ["firmware"]
---

本文
`;

function makeDeps(files: Record<string, Record<string, string>>) {
  // files: { knowledge: { "hardware/kb-....md": raw }, decisions: { "2026/dr-....md": raw } }
  const logger = { warn: vi.fn() };
  return {
    logger,
    deps: {
      logger,
      readdir: async (absDir: string): Promise<string[]> => {
        const sub = absDir.endsWith("knowledge") ? "knowledge" : "decisions";
        return Object.keys(files[sub] ?? {});
      },
      readFile: async (absPath: string): Promise<string> => {
        const sub = absPath.includes("/knowledge/") ? "knowledge" : "decisions";
        const rel = absPath.split(`/${sub}/`)[1] ?? "";
        const raw = files[sub]?.[rel];
        if (raw === undefined) throw new Error(`ENOENT ${absPath}`);
        return raw;
      },
    },
  };
}

describe("collectKbEvidence(ADR-0017 D4: knowledge の owner/people + decisions の deciders)", () => {
  it("knowledge: owner は max(created, last_verified)・people は created。material に title/domain/tags", async () => {
    const { deps } = makeDeps({ knowledge: { "hardware/kb-2026-0142-x.md": KNOWLEDGE } });
    const out = await collectKbEvidence("/kb", deps);
    expect(out).toHaveLength(1);
    expect(out[0]?.material).toEqual({
      id: "kb:kb-2026-0142",
      kind: "kb-entry",
      title: "分注ユニット X の湿度対策",
      domain: "hardware",
      tags: ["dispenser-x"],
    });
    const people = Object.fromEntries(out[0]?.people.map((p) => [p.person, p]) ?? []);
    // owner(yamada)は people[] にも居るが二重計上しない(count 1・lastActive は owner 側の新しい方)
    expect(people["yamada"]).toEqual({ person: "yamada", count: 1, lastActive: "2026-07-01" });
    expect(people["suzuki"]).toEqual({ person: "suzuki", count: 1, lastActive: "2026-06-10" });
  });

  it("decisions: deciders 各人が date で計上され、material は domain 無し", async () => {
    const { deps } = makeDeps({ decisions: { "2026/dr-2026-0031-swd.md": DECISION } });
    const out = await collectKbEvidence("/kb", deps);
    expect(out[0]?.material).toEqual({
      id: "kb:dr-2026-0031",
      kind: "kb-entry",
      title: "ファームは SWD 書き込みに統一",
      tags: ["firmware"],
    });
    expect(out[0]?.people.map((p) => p.person).sort()).toEqual(["tanaka", "yamada"]);
    expect(out[0]?.people[0]?.lastActive).toBe("2026-05-20");
  });

  it("壊れたエントリは warn + skip(他のエントリは生きる)", async () => {
    const { deps, logger } = makeDeps({
      knowledge: {
        "hardware/broken.md": "---\nid: kb-2026-0001\n---\n", // 必須欠落
        "hardware/kb-2026-0142-x.md": KNOWLEDGE,
      },
    });
    const out = await collectKbEvidence("/kb", deps);
    expect(out).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("KB が空(ディレクトリ無し相当)なら空配列", async () => {
    const { deps } = makeDeps({});
    expect(await collectKbEvidence("/kb", deps)).toEqual([]);
  });
});
