import type { CommitSummary } from "@stratum/gh-client";
import { describe, expect, it, vi } from "vitest";
import { collectCommitEvidence } from "./commit-collector.js";

const logger = { warn: vi.fn(), info: vi.fn() };
const c = (author: string | null, at: string): CommitSummary => ({
  sha: `sha-${author}-${at}`,
  author,
  authoredAt: at,
});

describe("collectCommitEvidence(ADR-0017 D2: login のみ・リポ単位の失敗隔離)", () => {
  it("author 別に count / lastActive(dateOnly)を集計する", async () => {
    const gh = {
      listCommits: vi.fn(async () => [
        c("yamada", "2026-07-01T10:00:00Z"),
        c("yamada", "2026-07-03T09:00:00Z"),
        c("suzuki", "2026-06-20T00:00:00Z"),
      ]),
    };
    const r = await collectCommitEvidence(["o/app"], gh, "2026-04-15T00:00:00Z", logger);
    expect(gh.listCommits).toHaveBeenCalledWith("o/app", { since: "2026-04-15T00:00:00Z" });
    expect(r.materials[0]?.material).toEqual({ id: "repo:o/app", kind: "repo", repo: "o/app" });
    const people = Object.fromEntries(r.materials[0]?.people.map((p) => [p.person, p]) ?? []);
    expect(people["yamada"]).toEqual({ person: "yamada", count: 2, lastActive: "2026-07-03" });
    expect(people["suzuki"]).toEqual({ person: "suzuki", count: 1, lastActive: "2026-06-20" });
  });

  it("author null は集計から除外し unattributedCommits に計上(silent drop しない)", async () => {
    const gh = {
      listCommits: async () => [
        c(null, "2026-07-01T00:00:00Z"),
        c("yamada", "2026-07-02T00:00:00Z"),
      ],
    };
    const r = await collectCommitEvidence(["o/app"], gh, "s", logger);
    expect(r.unattributedCommits).toEqual({ "o/app": 1 });
    expect(r.materials[0]?.people).toHaveLength(1);
  });

  it("全 commit が author 不明なら material を作らない(people 空 topic は表現不能・§4.5)", async () => {
    const gh = { listCommits: async () => [c(null, "2026-07-01T00:00:00Z")] };
    const r = await collectCommitEvidence(["o/app"], gh, "s", logger);
    expect(r.materials).toEqual([]);
    expect(r.unattributedCommits).toEqual({ "o/app": 1 });
  });

  it("リポ単位の失敗隔離: 1 リポの失敗で他は生きる + failedRepos に記録", async () => {
    const gh = {
      listCommits: vi.fn(async (repo: string) => {
        if (repo === "o/broken") throw new Error("403");
        return [c("yamada", "2026-07-01T00:00:00Z")];
      }),
    };
    const r = await collectCommitEvidence(["o/broken", "o/app"], gh, "s", logger);
    expect(r.failedRepos).toEqual(["o/broken"]);
    expect(r.materials.map((m) => m.material.id)).toEqual(["repo:o/app"]);
  });

  it("targets 空なら何もしない(KB evidence 単独運用)", async () => {
    const gh = { listCommits: vi.fn(async () => []) };
    const r = await collectCommitEvidence([], gh, "s", logger);
    expect(r.materials).toEqual([]);
    expect(gh.listCommits).not.toHaveBeenCalled();
  });
});
