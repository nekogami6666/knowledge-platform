import { describe, expect, it } from "vitest";
import { createRepoRegistry } from "./repo-registry.js";
import type { ScopedRepo } from "./repo-scope.js";

const a: ScopedRepo = { repo: "org/a", dir: "a", syncOnAsk: true, managed: false };
const b: ScopedRepo = { repo: "org/b", dir: "b", syncOnAsk: false, managed: true };

describe("createRepoRegistry(ADR-0036 D5)", () => {
  it("初期の検索範囲を返し、setScope で差し替える", () => {
    const r = createRepoRegistry([a]);
    expect(r.scope()).toEqual([a]);
    r.setScope([a, b]);
    expect(r.scope().map((x) => x.repo)).toEqual(["org/a", "org/b"]);
  });

  it("recordSynced は最新の SyncedRepo を保持し、直近の失敗を消す", () => {
    const r = createRepoRegistry([a]);
    r.recordError("org/a", new Error("boom"));
    expect(r.lastError("org/a")).toBe("boom");
    r.recordSynced({ repo: "org/a", absDir: "/c/a", resolvedCommit: "s1" });
    r.recordSynced({ repo: "org/a", absDir: "/c/a", resolvedCommit: "s2" });
    expect(r.lastSynced("org/a")?.resolvedCommit).toBe("s2");
    expect(r.lastError("org/a")).toBeUndefined();
  });

  it("recordError は前回の SyncedRepo を残す(失敗したリポは前回の状態で使う)", () => {
    const r = createRepoRegistry([a]);
    r.recordSynced({ repo: "org/a", absDir: "/c/a", resolvedCommit: "s1" });
    r.recordError("org/a", "fetch failed");
    expect(r.lastSynced("org/a")?.resolvedCommit).toBe("s1");
    expect(r.lastError("org/a")).toBe("fetch failed");
  });

  it("失敗メッセージから URL の認証情報を落とす(§9.1 多重防御)", () => {
    const r = createRepoRegistry([a]);
    r.recordError(
      "org/a",
      new Error("Command failed: git fetch https://x-access-token:SECRET@github.com/org/a.git"),
    );
    expect(r.lastError("org/a")).not.toContain("SECRET");
    expect(r.lastError("org/a")).toContain("https://github.com/org/a.git");
  });

  it("recordEmpty は空リポとして記録し、recordSynced で解除される", () => {
    const r = createRepoRegistry([a]);
    r.recordSynced({ repo: "org/a", absDir: "/c/a", resolvedCommit: "s1" });
    r.recordError("org/a", "x");
    r.recordEmpty("org/a");
    expect(r.isEmpty("org/a")).toBe(true);
    expect(r.lastSynced("org/a")).toBeUndefined();
    expect(r.lastError("org/a")).toBeUndefined();
    r.recordSynced({ repo: "org/a", absDir: "/c/a", resolvedCommit: "s2" });
    expect(r.isEmpty("org/a")).toBe(false);
  });

  it("setScope で範囲外になったリポの同期状態を捨てる。forget も同様", () => {
    const r = createRepoRegistry([a, b]);
    r.recordSynced({ repo: "org/a", absDir: "/c/a", resolvedCommit: "s1" });
    r.recordSynced({ repo: "org/b", absDir: "/c/b", resolvedCommit: "s2" });
    r.recordError("org/b", "x");
    r.setScope([a]);
    expect(r.lastSynced("org/b")).toBeUndefined();
    expect(r.lastError("org/b")).toBeUndefined();
    expect(r.lastSynced("org/a")?.resolvedCommit).toBe("s1");
    r.forget("org/a");
    expect(r.lastSynced("org/a")).toBeUndefined();
  });
});
