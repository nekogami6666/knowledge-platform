import { describe, expect, it } from "vitest";
import type { Logger } from "./logger.js";
import { collectOverdue } from "./overdue.js";

function entryRaw(over: {
  id?: string;
  type?: string;
  status?: string;
  lastVerified: string;
  interval?: number;
}): string {
  return [
    "---",
    `id: ${over.id ?? "kb-2026-0001"}`,
    "title: タイトル",
    `type: ${over.type ?? "fact"}`,
    "domain: hardware",
    "sources:",
    "  - kind: discord",
    '    url: "https://discord.com/channels/1/2/3"',
    "confidence: high",
    `status: ${over.status ?? "active"}`,
    'created: "2026-01-01"',
    `last_verified: "${over.lastVerified}"`,
    ...(over.interval === undefined ? [] : [`review_interval_days: ${over.interval}`]),
    "owner: yamada",
    "---",
    "",
    "本文。",
    "",
  ].join("\n");
}

function nullLogger(warns: string[] = []): Logger {
  return { info: () => {}, warn: (msg) => warns.push(msg), error: () => {} };
}

const TODAY = "2026-07-15";

describe("collectOverdue(§6.7 / ADR-0019 D1)", () => {
  it("active かつ期限超過(fact は 180 日既定)だけを、期限の古い順で返す", () => {
    const files = [
      {
        path: "knowledge/hw/b.md",
        raw: entryRaw({ id: "kb-2026-0002", lastVerified: "2026-01-10" }),
      },
      {
        path: "knowledge/hw/a.md",
        raw: entryRaw({ id: "kb-2026-0001", lastVerified: "2026-01-01" }),
      },
      {
        path: "knowledge/hw/c.md",
        raw: entryRaw({ id: "kb-2026-0003", lastVerified: "2026-07-01" }),
      },
    ];
    const out = collectOverdue(files, TODAY, nullLogger());
    expect(out.map((o) => o.path)).toEqual(["knowledge/hw/a.md", "knowledge/hw/b.md"]);
    expect(out[0]?.dueDate).toBe("2026-06-30");
  });

  it("期限当日(dueDate === today)はまだ超過ではない", () => {
    // 2026-01-16 + 180 日 = 2026-07-15 = today。
    const files = [{ path: "knowledge/hw/a.md", raw: entryRaw({ lastVerified: "2026-01-16" }) }];
    expect(collectOverdue(files, TODAY, nullLogger())).toEqual([]);
  });

  it("active 以外(stale / deprecated)は対象外", () => {
    const files = [
      { path: "knowledge/hw/a.md", raw: entryRaw({ lastVerified: "2026-01-01", status: "stale" }) },
    ];
    expect(collectOverdue(files, TODAY, nullLogger())).toEqual([]);
  });

  it("type: decision は review_interval_days が null のため対象外(§4.2)", () => {
    const files = [
      {
        path: "knowledge/hw/a.md",
        raw: entryRaw({ lastVerified: "2020-01-01", type: "decision" }),
      },
    ];
    expect(collectOverdue(files, TODAY, nullLogger())).toEqual([]);
  });

  it("明示の review_interval_days を尊重する", () => {
    const files = [
      { path: "knowledge/hw/a.md", raw: entryRaw({ lastVerified: "2026-07-01", interval: 7 }) },
    ];
    expect(collectOverdue(files, TODAY, nullLogger())).toHaveLength(1);
  });

  it("parse できないファイルは warn してスキップ(全体を止めない)", () => {
    const warns: string[] = [];
    const files = [
      { path: "knowledge/hw/broken.md", raw: "## frontmatter なし\n" },
      { path: "knowledge/hw/a.md", raw: entryRaw({ lastVerified: "2026-01-01" }) },
    ];
    expect(collectOverdue(files, TODAY, nullLogger(warns))).toHaveLength(1);
    expect(warns).toHaveLength(1);
  });
});
