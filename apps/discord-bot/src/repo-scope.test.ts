import type { OrgRepo } from "@stratum/gh-client";
import { describe, expect, it } from "vitest";
import { type RepoScopeAllVisible, resolveRepoScope } from "./repo-scope.js";
import type { RepoSpec } from "./repos.js";

function gh(name: string, over: Partial<OrgRepo> = {}): OrgRepo {
  return {
    name,
    fullName: `org/${name}`,
    archived: false,
    fork: false,
    description: null,
    ...over,
  };
}

function av(over: Partial<RepoScopeAllVisible> = {}): RepoScopeAllVisible {
  return { org: "org", exclude: [], sync_on_ask: [], ...over };
}

const KB: RepoSpec = {
  repo: "org/knowledge-base",
  dir: "knowledge-base",
  url: "https://github.com/org/knowledge-base.git",
};

describe("resolveRepoScope: all_visible なし(従来挙動)", () => {
  it("手動指定をそのまま・全件 syncOnAsk / 非 managed。visible は無視", () => {
    const manual: RepoSpec[] = [KB, { repo: "org/local", dir: "local" }];
    const out = resolveRepoScope({ manual, allVisible: null, visible: [gh("other")] });
    expect(out).toEqual({
      repos: [
        { ...KB, syncOnAsk: true, managed: false },
        { repo: "org/local", dir: "local", syncOnAsk: true, managed: false },
      ],
      excluded: [],
    });
  });

  it("手動指定も空なら空", () => {
    expect(resolveRepoScope({ manual: [], allVisible: null, visible: [] })).toEqual({
      repos: [],
      excluded: [],
    });
  });
});

describe("resolveRepoScope: 列挙分(ADR-0036 D1〜D3)", () => {
  it("repo=fullName / dir=name / トークン無し url / description を持つ managed エントリにする", () => {
    const out = resolveRepoScope({
      manual: [],
      allVisible: av(),
      visible: [gh("app", { description: "業務アプリ" }), gh("tool")],
    });
    expect(out.repos).toEqual([
      {
        repo: "org/app",
        dir: "app",
        url: "https://github.com/org/app.git",
        description: "業務アプリ",
        syncOnAsk: false,
        managed: true,
      },
      {
        repo: "org/tool",
        dir: "tool",
        url: "https://github.com/org/tool.git",
        syncOnAsk: false,
        managed: true,
      },
    ]);
    expect(out.repos[1]).not.toHaveProperty("description");
    expect(out.excluded).toEqual([]);
  });

  it("アーカイブ・フォークは常に除外し理由を記録する", () => {
    const out = resolveRepoScope({
      manual: [],
      allVisible: av(),
      visible: [gh("old", { archived: true }), gh("forked", { fork: true }), gh("live")],
    });
    expect(out.repos.map((r) => r.repo)).toEqual(["org/live"]);
    expect(out.excluded).toEqual([
      { repo: "org/forked", reason: "fork" },
      { repo: "org/old", reason: "archived" },
    ]);
  });

  it("exclude は大小無視の完全一致で、name と org/name の両形式を受ける(部分一致はしない)", () => {
    const out = resolveRepoScope({
      manual: [],
      allVisible: av({ exclude: ["Secret-Repo", "ORG/other-secret"] }),
      visible: [gh("secret-repo"), gh("other-secret"), gh("secret-repo-public")],
    });
    expect(out.repos.map((r) => r.repo)).toEqual(["org/secret-repo-public"]);
    expect(out.excluded).toEqual([
      { repo: "org/other-secret", reason: "exclude" },
      { repo: "org/secret-repo", reason: "exclude" },
    ]);
  });

  it("sync_on_ask: 名前一致と `*` glob(大小無視)。当たらない列挙分は false", () => {
    const out = resolveRepoScope({
      manual: [],
      allVisible: av({ sync_on_ask: ["knowledge-base", "*-Minutes"] }),
      visible: [gh("knowledge-base"), gh("dev-minutes"), gh("biz-minutes"), gh("minutes-app")],
    });
    expect(Object.fromEntries(out.repos.map((r) => [r.dir, r.syncOnAsk]))).toEqual({
      "biz-minutes": true,
      "dev-minutes": true,
      "knowledge-base": true,
      "minutes-app": false,
    });
  });

  it("sync_on_ask の org/name 形式は fullName と照合し、正規表現の記号は文字として扱う", () => {
    const out = resolveRepoScope({
      manual: [],
      allVisible: av({ sync_on_ask: ["org/a.b", "other/c"] }),
      visible: [gh("a.b"), gh("aXb"), gh("c")],
    });
    expect(Object.fromEntries(out.repos.map((r) => [r.dir, r.syncOnAsk]))).toEqual({
      "a.b": true,
      aXb: false,
      c: false,
    });
  });

  it("dir として安全でない名前は conflict で外す(防御)", () => {
    const out = resolveRepoScope({
      manual: [],
      allVisible: av(),
      visible: [gh(".github"), gh(".."), gh("a/b"), gh("a\\b"), gh("ok")],
    });
    expect(out.repos.map((r) => r.dir)).toEqual(["ok"]);
    expect(out.excluded.map((e) => e.reason)).toEqual([
      "conflict",
      "conflict",
      "conflict",
      "conflict",
    ]);
  });
});

describe("resolveRepoScope: 手動指定との和集合(手動が優先)", () => {
  it("同じ repo(大小無視)は重複として列挙分を捨て、除外扱いにしない。手動側は GitHub の description を得る", () => {
    const out = resolveRepoScope({
      manual: [{ ...KB, repo: "ORG/Knowledge-Base" }],
      allVisible: av(),
      visible: [gh("knowledge-base", { description: "ナレッジ" }), gh("app")],
    });
    expect(out.repos).toEqual([
      {
        ...KB,
        repo: "ORG/Knowledge-Base",
        description: "ナレッジ",
        syncOnAsk: true,
        managed: false,
      },
      {
        repo: "org/app",
        dir: "app",
        url: "https://github.com/org/app.git",
        syncOnAsk: false,
        managed: true,
      },
    ]);
    expect(out.excluded).toEqual([]);
  });

  it("別 repo で dir が衝突する列挙分は conflict で捨てる(手動の clone 先を守る)", () => {
    const out = resolveRepoScope({
      manual: [{ repo: "other-org/minutes", dir: "Minutes" }],
      allVisible: av(),
      visible: [gh("minutes"), gh("app")],
    });
    expect(out.repos.map((r) => r.repo)).toEqual(["other-org/minutes", "org/app"]);
    expect(out.excluded).toEqual([{ repo: "org/minutes", reason: "conflict" }]);
  });

  it("exclude は手動指定を外さない(明示の意図)。アーカイブ済みでも手動指定なら残り除外記録もしない", () => {
    const out = resolveRepoScope({
      manual: [KB, { repo: "org/archived-notes", dir: "archived-notes" }],
      allVisible: av({ exclude: ["knowledge-base"] }),
      visible: [gh("knowledge-base"), gh("archived-notes", { archived: true })],
    });
    expect(out.repos.map((r) => [r.repo, r.managed, r.syncOnAsk])).toEqual([
      ["org/knowledge-base", false, true],
      ["org/archived-notes", false, true],
    ]);
    expect(out.excluded).toEqual([]);
  });

  it("手動指定は sync_on_ask に無くても常に syncOnAsk(従来どおり /ask ごとに同期)", () => {
    const out = resolveRepoScope({
      manual: [{ repo: "org/local", dir: "local" }],
      allVisible: av({ sync_on_ask: ["nothing-matches"] }),
      visible: [],
    });
    expect(out.repos).toEqual([
      { repo: "org/local", dir: "local", syncOnAsk: true, managed: false },
    ]);
  });

  it("順序は決定的: 手動(与えた順)→ 列挙分(name 昇順・入力順に依存しない)", () => {
    const manual: RepoSpec[] = [
      { repo: "org/zeta", dir: "zeta" },
      { repo: "org/alpha", dir: "alpha" },
    ];
    const visible = [gh("Charlie"), gh("bravo"), gh("delta"), gh("alpha")];
    const a = resolveRepoScope({ manual, allVisible: av(), visible });
    const b = resolveRepoScope({ manual, allVisible: av(), visible: [...visible].reverse() });
    expect(a.repos.map((r) => r.dir)).toEqual(["zeta", "alpha", "bravo", "Charlie", "delta"]);
    expect(b).toEqual(a);
  });
});
