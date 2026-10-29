import { describe, expect, it } from "vitest";
import {
  aggregateOpsEvents,
  classifyFailure,
  formatDeployMessage,
  formatFailureMessage,
  formatOpsWeekly,
  formatRecoveredMessage,
  type OpsEvent,
  type OpsNotifyDeps,
  parseOpsEvents,
  pickErrorLines,
  runOpsNotify,
} from "./ops-notify.js";

const U = "stratum-extractor-discord.service";

describe("classifyFailure", () => {
  it.each([
    [
      "GhClientError API_ERROR: PR 一覧の取得に失敗しました(o/r)(HTTP 502) ← HttpError HTTP 502",
      "transient",
    ],
    ["TypeError: fetch failed ← Error ECONNRESET syscall=read", "transient"],
    ["HttpError HTTP 401 GET https://api.github.com/x: Bad credentials", "auth"],
    ["HttpError HTTP 429: API rate limit exceeded", "rate_limit"],
    ["LlmError TIMEOUT: agent search timed out", "timeout"],
    ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@stratum/shared'", "build"],
    ["ZodError: Invalid input at kb.repo", "config"],
    ["something odd happened", "unknown"],
  ])("%s → %s", (line, category) => {
    expect(classifyFailure([line], U).category).toBe(category);
  });

  it("認証の 401 は 5xx 等より先に判定する", () => {
    expect(classifyFailure(["HTTP 401 ← fetch failed"], U).category).toBe("auth");
  });

  it("一時障害の hint は unit 名入りの再実行コマンド", () => {
    expect(classifyFailure(["HTTP 503"], U).hint).toContain(`systemctl --user start ${U}`);
  });
});

describe("pickErrorLines / formatFailureMessage", () => {
  const lines = [
    "Starting stratum-extractor-discord.service...",
    "extractor-discord failed: GhClientError API_ERROR: PR 一覧の取得に失敗しました(o/r)(HTTP 502)",
    "clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git failed",
    "stratum-extractor-discord.service: Triggering OnFailure= dependencies.",
  ];

  it("エラー行だけを拾い、資格情報を伏せる", () => {
    const picked = pickErrorLines(lines);
    expect(picked).toHaveLength(2);
    expect(picked.join("\n")).not.toContain("ghs_abcdef");
  });

  it("分類・エラー行・まず試すことを含む", () => {
    const msg = formatFailureMessage(U, lines);
    expect(msg).toContain(`❌ **VM タイマーが失敗しました**: ${U}`);
    expect(msg).toContain("原因の分類: 外部サービス・ネットワークの一時障害");
    expect(msg).toContain("まず試すこと:");
    expect(msg).toContain("HTTP 502");
  });
});

describe("formatDeployMessage / formatRecoveredMessage", () => {
  it("fix は「直したこと」、feat/perf は「改善・追加」に分け、それ以外は載せない", () => {
    const msg = formatDeployMessage("aaaaaaa111", "bbbbbbb222", [
      "fix(deploy): 失敗通知を直す (#185)",
      "feat(shared): エラー原因を詳しく出す (#186)",
      "perf(ask): 事前起動 (#184)",
      "docs: 手順を足す",
      "Merge branch x",
    ]);
    expect(msg).toContain("aaaaaaa → bbbbbbb");
    expect(msg).toContain("**直したこと**\n- fix(deploy): 失敗通知を直す (#185)");
    expect(msg).toContain("**改善・追加**");
    expect(msg).not.toContain("docs:");
  });

  it("載せるものが無ければ null(通知しない)", () => {
    expect(formatDeployMessage("a", "b", ["docs: x", "chore: y"])).toBeNull();
  });

  it("復旧通知に失敗時刻を添える", () => {
    expect(formatRecoveredMessage(U, "2026-10-23T09:05:25+09:00")).toBe(
      `✅ **復旧しました**: ${U} が正常に終わりました(10-23 09:05 の失敗から)`,
    );
  });
});

function fakeDeps(markers: Map<string, string> = new Map()) {
  const posts: string[] = [];
  const events: OpsEvent[] = [];
  const deps: OpsNotifyDeps = {
    post: async (c) => {
      posts.push(c);
    },
    readMarker: (u) => markers.get(u) ?? null,
    writeMarker: (u, ts) => markers.set(u, ts),
    removeMarker: (u) => markers.delete(u),
    appendEvent: (e) => events.push(e),
    now: () => "2026-10-29T10:00:00+09:00",
  };
  return { deps, posts, events, markers };
}

describe("runOpsNotify", () => {
  it("失敗: 印を残し、出来事を記録して通知する(印は最初の失敗時刻を保つ)", async () => {
    const f = fakeDeps(new Map([[U, "2026-10-28T09:00:00+09:00"]]));
    await runOpsNotify({ kind: "failure", unit: U, lines: ["failed: HTTP 502"] }, f.deps);
    expect(f.markers.get(U)).toBe("2026-10-28T09:00:00+09:00");
    expect(f.events).toEqual([
      { ts: "2026-10-29T10:00:00+09:00", kind: "failure", unit: U, category: "transient" },
    ]);
    expect(f.posts).toHaveLength(1);
  });

  it("復旧: 印があれば通知して消す・無ければ何もしない", async () => {
    const f = fakeDeps(new Map([[U, "2026-10-23T09:05:25+09:00"]]));
    await runOpsNotify({ kind: "recovered", unit: U }, f.deps);
    expect(f.posts[0]).toContain("✅ **復旧しました**");
    expect(f.markers.has(U)).toBe(false);

    const g = fakeDeps();
    await runOpsNotify({ kind: "recovered", unit: U }, g.deps);
    expect(g.posts).toEqual([]);
    expect(g.events).toEqual([]);
  });

  it("本番更新: 載せるものが無くても回数は記録する", async () => {
    const f = fakeDeps();
    await runOpsNotify({ kind: "deploy", fromSha: "a", toSha: "b", subjects: ["docs: x"] }, f.deps);
    expect(f.posts).toEqual([]);
    expect(f.events).toEqual([{ ts: "2026-10-29T10:00:00+09:00", kind: "deploy" }]);
  });
});

describe("週次の運用節", () => {
  const jsonl = [
    JSON.stringify({ ts: "2026-10-20T09:00:00+09:00", kind: "failure", unit: "old" }),
    JSON.stringify({
      ts: "2026-10-23T09:05:25+09:00",
      kind: "failure",
      unit: U,
      category: "transient",
    }),
    "{broken",
    JSON.stringify({ ts: "2026-10-27T09:00:42+09:00", kind: "recovered", unit: U }),
    JSON.stringify({ ts: "2026-10-29T14:00:00+09:00", kind: "deploy" }),
  ].join("\n");

  it("壊れた行を飛ばし、直近の失敗・復旧・更新を数える", () => {
    const w = aggregateOpsEvents(parseOpsEvents(jsonl), "2026-10-22T00:00:00+09:00", []);
    expect(w).toMatchObject({ failures: 1, recovered: 1, deploys: 1 });
    expect(w.byUnit).toEqual([{ unit: U, count: 1, category: "transient" }]);
    expect(formatOpsWeekly(w).join("\n")).toContain(`${U}: 1 回・一時障害`);
  });

  it("失敗が無ければ「失敗なし」、失敗中のままは ⚠️", () => {
    expect(formatOpsWeekly(aggregateOpsEvents([], "2026-10-22", []))).toContain("- 失敗なし");
    const w = aggregateOpsEvents([], "2026-10-22", [U]);
    expect(formatOpsWeekly(w).join("\n")).toContain(`⚠️ 失敗中のまま: ${U}`);
  });
});
