import type { ExpertiseMap } from "@stratum/kb-core";
import { describe, expect, it } from "vitest";
import { rankByExpertise } from "./expertise.js";
import { selectAssignee } from "./question.js";

const MAP: ExpertiseMap = {
  generated_at: "2026-07-20T02:00:00+09:00",
  topics: [
    {
      topic: "dispenser-x-firmware",
      label: "分注ユニット X ファームウェア",
      people: [
        { name: "yamada", evidence_count: 23, last_active: "2026-07-05" },
        { name: "suzuki", evidence_count: 3, last_active: "2026-06-01" },
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

describe("rankByExpertise(§4.4 L302: 質問 → topic の素朴マッチ)", () => {
  it("label が質問文に含まれれば、その topic の people(evidence 降順)を返す", () => {
    expect(rankByExpertise("分注ユニット X ファームウェアの書き込み手順は?", MAP)).toEqual([
      "yamada",
      "suzuki",
    ]);
  });

  it("topic id の一致でも当たる(label 一致が優先)", () => {
    expect(rankByExpertise("assay-protocol の温度条件は?", MAP)).toEqual(["tanaka"]);
  });

  it("手掛かりが無ければ [](ラウンドロビンへフォールバック — 公平性の既定を崩さない)", () => {
    expect(rankByExpertise("お昼どこで食べる?", MAP)).toEqual([]);
  });
});

describe("selectAssignee の expertise 優先(preferred ∩ assignees → ラウンドロビン)", () => {
  const assignees = [
    { github: "suzuki", discord: "1" },
    { github: "tanaka", discord: "2" },
  ];

  // preferred は run.ts が github→discord へ写像した後の discord ID 配列(ADR-0022)。
  it("preferred の先頭から assignees に居る人を優先する(プール外 discord は飛ばす)", () => {
    const a = selectAssignee(assignees, 0, () => true, ["9", "1"]); // 9=プール外, 1=suzuki
    expect(a?.github).toBe("suzuki");
  });

  it("preferred が週上限ならラウンドロビンへフォールバック", () => {
    const a = selectAssignee(assignees, 1, (d) => d !== "1", ["1"]); // suzuki(discord 1)満杯
    expect(a?.github).toBe("tanaka");
  });

  it("preferred 無し(空)は従来のラウンドロビンと同じ", () => {
    const a = selectAssignee(assignees, 1, () => true);
    expect(a?.github).toBe("tanaka"); // startIndex=1
  });

  it("同じ人に tryReserve を二重に試さない(preferred とラウンドロビンの重複排除・discord キー)", () => {
    const calls: string[] = [];
    selectAssignee(
      assignees,
      0,
      (d) => {
        calls.push(d);
        return false;
      },
      ["1"], // suzuki の discord
    );
    expect(calls).toEqual(["1", "2"]); // suzuki(1) は 1 回だけ、次に tanaka(2)
  });
});
