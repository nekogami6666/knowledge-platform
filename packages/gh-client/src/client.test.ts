import { describe, expect, it, vi } from "vitest";
import { createGhClient, type OctokitLike, splitRepo } from "./client.js";
import { GhClientError } from "./errors.js";

type GetContentFn = (p: {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}) => Promise<{ data: unknown }>;

const defaultGetContent: GetContentFn = async () => ({
  data: {
    type: "file",
    content: Buffer.from("hello", "utf8").toString("base64"),
    encoding: "base64",
    sha: "FILESHA",
  },
});

type ListFn = OctokitLike["rest"]["pulls"]["list"];
type ReviewCommentsFn = OctokitLike["rest"]["pulls"]["listReviewComments"];
type ListFilesFn = OctokitLike["rest"]["pulls"]["listFiles"];
type IssueCommentsFn = OctokitLike["rest"]["issues"]["listComments"];

function fakeOctokit(
  over: {
    getContent?: GetContentFn;
    list?: ListFn;
    listReviewComments?: ReviewCommentsFn;
    listFiles?: ListFilesFn;
    listComments?: IssueCommentsFn;
  } = {},
) {
  const defaultList: ListFn = async () => ({
    data: [
      {
        number: 7,
        title: "Extract: a..b",
        head: { ref: "extract/x" },
        html_url: "https://github.com/o/r/pull/7",
      },
    ],
  });
  return {
    rest: {
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: "BASESHA" } } })),
        createBlob: vi.fn(async (p: { content: string }) => ({
          data: { sha: `blob:${p.content}` },
        })),
        createTree: vi.fn(async () => ({ data: { sha: "TREESHA" } })),
        createCommit: vi.fn(async () => ({ data: { sha: "COMMITSHA" } })),
        createRef: vi.fn(async () => ({ data: {} })),
        updateRef: vi.fn(async () => ({ data: {} })),
      },
      pulls: {
        create: vi.fn(async () => ({
          data: { number: 42, html_url: "https://github.com/o/r/pull/42" },
        })),
        list: vi.fn<ListFn>(over.list ?? defaultList),
        merge: vi.fn(async () => ({ data: {} })),
        // OctokitLike の get 型で明示(mergeable_state は optional。欠落ケースのモックを許すため)。
        get: vi.fn<OctokitLike["rest"]["pulls"]["get"]>(async () => ({
          data: {
            number: 7,
            state: "open",
            merged: false,
            mergeable_state: "clean",
            title: "Extract: a..b",
            html_url: "https://github.com/o/r/pull/7",
          },
        })),
        listReviewComments: vi.fn<ReviewCommentsFn>(
          over.listReviewComments ?? (async () => ({ data: [] })),
        ),
        listFiles: vi.fn<ListFilesFn>(over.listFiles ?? (async () => ({ data: [] }))),
      },
      issues: {
        listComments: vi.fn<IssueCommentsFn>(over.listComments ?? (async () => ({ data: [] }))),
      },
      repos: {
        getContent: vi.fn(over.getContent ?? defaultGetContent),
      },
    },
  };
}

describe("splitRepo", () => {
  it("org/name を分解する", () => {
    expect(splitRepo("queeenb-com/knowledge-base")).toEqual({
      owner: "queeenb-com",
      repo: "knowledge-base",
    });
  });
  it("不正形式は GhClientError", () => {
    expect(() => splitRepo("nope")).toThrow(GhClientError);
  });
});

describe("createPullRequest", () => {
  it("複数ファイルを 1 コミットの PR にする(Git Data API の順序)", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    const res = await gh.createPullRequest({
      repo: "o/r",
      head: "feat-x",
      title: "T",
      body: "B",
      files: [
        { path: "a.md", content: "a" },
        { path: "b.md", content: "b" },
      ],
    });
    expect(res).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
    expect(oct.rest.git.getRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "heads/main" });
    expect(oct.rest.git.createBlob).toHaveBeenCalledTimes(2);
    // "a" → base64 "YQ==", "b" → "Yg=="
    expect(oct.rest.git.createBlob).toHaveBeenNthCalledWith(1, {
      owner: "o",
      repo: "r",
      content: "YQ==",
      encoding: "base64",
    });
    expect(oct.rest.git.createTree).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      base_tree: "BASESHA",
      tree: [
        { path: "a.md", mode: "100644", type: "blob", sha: "blob:YQ==" },
        { path: "b.md", mode: "100644", type: "blob", sha: "blob:Yg==" },
      ],
    });
    expect(oct.rest.git.createCommit).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      message: "T",
      tree: "TREESHA",
      parents: ["BASESHA"],
    });
    expect(oct.rest.git.createRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "refs/heads/feat-x",
      sha: "COMMITSHA",
    });
    expect(oct.rest.pulls.create).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      title: "T",
      body: "B",
      head: "feat-x",
      base: "main",
    });
  });

  it("base を指定できる", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    await gh.createPullRequest({
      repo: "o/r",
      head: "h",
      title: "T",
      body: "B",
      files: [{ path: "x", content: "x" }],
      base: "develop",
    });
    expect(oct.rest.git.getRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/develop",
    });
    expect(oct.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: "develop", head: "h" }),
    );
  });
});

describe("listPullRequests", () => {
  it("マッピング + 既定 state=open / per_page=30", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    const prs = await gh.listPullRequests("o/r");
    expect(prs).toEqual([
      {
        number: 7,
        title: "Extract: a..b",
        headRef: "extract/x",
        url: "https://github.com/o/r/pull/7",
      },
    ]);
    expect(oct.rest.pulls.list).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      state: "open",
      per_page: 30,
    });
  });
});

describe("mergePullRequest", () => {
  it("既定は squash", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    await gh.mergePullRequest({ repo: "o/r", number: 5 });
    expect(oct.rest.pulls.merge).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 5,
      merge_method: "squash",
      commit_title: undefined,
    });
  });
});

describe("getFileContents", () => {
  it("base64 を復号して content/sha を返す", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    expect(await gh.getFileContents({ repo: "o/r", path: "x.md" })).toEqual({
      content: "hello",
      sha: "FILESHA",
    });
  });

  it("404 は null", async () => {
    const oct = fakeOctokit({
      getContent: async () => {
        throw { status: 404 };
      },
    });
    const gh = createGhClient(oct as unknown as OctokitLike);
    expect(await gh.getFileContents({ repo: "o/r", path: "missing.md" })).toBeNull();
  });

  it("ディレクトリ(配列)は API_ERROR", async () => {
    const oct = fakeOctokit({ getContent: async () => ({ data: [] }) });
    const gh = createGhClient(oct as unknown as OctokitLike);
    let err: unknown;
    try {
      await gh.getFileContents({ repo: "o/r", path: "dir" });
    } catch (e) {
      err = e;
    }
    expect((err as GhClientError).code).toBe("API_ERROR");
  });
});

describe("getPullRequest", () => {
  it("state / merged / mergeable_state をマップする", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    const pr = await gh.getPullRequest("o/r", 7);
    expect(pr).toEqual({
      number: 7,
      state: "open",
      merged: false,
      mergeableState: "clean",
      title: "Extract: a..b",
      url: "https://github.com/o/r/pull/7",
    });
    expect(oct.rest.pulls.get).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7 });
  });

  it("mergeable_state 欠落(算出中)は null", async () => {
    const oct = fakeOctokit();
    oct.rest.pulls.get.mockResolvedValueOnce({
      data: { number: 7, state: "open", merged: false, title: "t", html_url: "u" },
    });
    const gh = createGhClient(oct as unknown as OctokitLike);
    expect((await gh.getPullRequest("o/r", 7)).mergeableState).toBeNull();
  });

  it("404 は NOT_FOUND", async () => {
    const oct = fakeOctokit();
    oct.rest.pulls.get.mockRejectedValueOnce({ status: 404 });
    const gh = createGhClient(oct as unknown as OctokitLike);
    let err: unknown;
    try {
      await gh.getPullRequest("o/r", 999);
    } catch (e) {
      err = e;
    }
    expect((err as GhClientError).code).toBe("NOT_FOUND");
  });
});

describe("commitFiles(§6.5 質問ログの直接 commit)", () => {
  it("既存ブランチ先端に blob→tree→commit を積み updateRef で前進させる", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    const r = await gh.commitFiles({
      repo: "o/r",
      branch: "main",
      message: "chore: add question q-2026-0001",
      files: [{ path: "questions/open/q-2026-0001.md", content: "x" }],
    });
    expect(r).toEqual({ sha: "COMMITSHA" });
    expect(oct.rest.git.getRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "heads/main" });
    expect(oct.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chore: add question q-2026-0001", parents: ["BASESHA"] }),
    );
    expect(oct.rest.git.updateRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/main",
      sha: "COMMITSHA",
    });
    expect(oct.rest.git.createRef).not.toHaveBeenCalled(); // 新ブランチは作らない
    expect(oct.rest.pulls.create).not.toHaveBeenCalled(); // PR も作らない
  });

  it("deletions は sha:null の tree エントリで削除する(open→answered の移動・§6.5)", async () => {
    const oct = fakeOctokit();
    const gh = createGhClient(oct as unknown as OctokitLike);
    await gh.commitFiles({
      repo: "o/r",
      branch: "main",
      message: "chore(gap): move q-2026-0001 to answered",
      files: [{ path: "questions/answered/q-2026-0001.md", content: "y" }],
      deletions: ["questions/open/q-2026-0001.md"],
    });
    // fake createTree は無引数 vi.fn のため calls の要素型が空タプル。regular 配列へ cast して読む。
    const calls = oct.rest.git.createTree.mock.calls as unknown as {
      tree: { path: string; sha: string | null }[];
    }[][];
    const tree = calls[0]?.[0]?.tree ?? [];
    const added = tree.find((t) => t.path === "questions/answered/q-2026-0001.md");
    const deleted = tree.find((t) => t.path === "questions/open/q-2026-0001.md");
    expect(added?.sha).toEqual(expect.any(String)); // blob 追加
    expect(deleted).toEqual(expect.objectContaining({ sha: null })); // 削除エントリ
  });

  it("updateRef の 422(non-fast-forward)は CONFLICT", async () => {
    const oct = fakeOctokit();
    oct.rest.git.updateRef.mockRejectedValueOnce({ status: 422 });
    const gh = createGhClient(oct as unknown as OctokitLike);
    let err: unknown;
    try {
      await gh.commitFiles({ repo: "o/r", branch: "main", message: "m", files: [] });
    } catch (e) {
      err = e;
    }
    expect((err as GhClientError).code).toBe("CONFLICT");
  });
});

// --- PR マイニング用の読み取り API(§6.4 ③-c / PR-P1)---

type PrRow = {
  number: number;
  title: string;
  head: { ref: string };
  html_url: string;
  body?: string | null;
  merged_at?: string | null;
  updated_at?: string;
  user?: { login: string } | null;
};

function prRow(over: Partial<PrRow> & { number: number }): PrRow {
  return {
    title: `PR ${over.number}`,
    head: { ref: `feat/${over.number}` },
    html_url: `https://github.com/o/r/pull/${over.number}`,
    body: "body",
    merged_at: "2026-07-05T00:00:00Z",
    updated_at: "2026-07-05T00:00:00Z",
    user: { login: "yamada" },
    ...over,
  };
}

describe("listMergedPullRequests", () => {
  it("since 以降にマージされた PR を返し、未マージ close と期間外を除外する", async () => {
    const list: ListFn = async () => ({
      data: [
        prRow({
          number: 10,
          merged_at: "2026-07-06T00:00:00Z",
          updated_at: "2026-07-06T00:00:00Z",
        }),
        prRow({ number: 11, merged_at: null, updated_at: "2026-07-06T00:00:00Z" }), // 未マージ close
        prRow({
          number: 12,
          merged_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-06T00:00:00Z",
        }), // since より前にマージ
      ],
    });
    const oct = fakeOctokit({ list });
    const gh = createGhClient(oct as unknown as OctokitLike);
    const prs = await gh.listMergedPullRequests("o/r", { since: "2026-07-03T00:00:00Z" });
    expect(prs.map((p) => p.number)).toEqual([10]);
    expect(prs[0]).toMatchObject({
      number: 10,
      body: "body",
      author: "yamada",
      mergedAt: "2026-07-06T00:00:00Z",
      url: "https://github.com/o/r/pull/10",
    });
  });

  it("updated_at < since に到達したら以降のページを取得しない(早期打ち切り)", async () => {
    const list = vi.fn<ListFn>(async (p) => {
      if (p.page === 1) {
        return {
          data: [
            prRow({
              number: 20,
              updated_at: "2026-07-06T00:00:00Z",
              merged_at: "2026-07-06T00:00:00Z",
            }),
            // 2 件目で since より古い更新 → ここで打ち切り。3 件目以降・2 ページ目は見ない。
            prRow({
              number: 21,
              updated_at: "2026-06-01T00:00:00Z",
              merged_at: "2026-06-01T00:00:00Z",
            }),
            prRow({
              number: 22,
              updated_at: "2026-07-06T00:00:00Z",
              merged_at: "2026-07-06T00:00:00Z",
            }),
          ],
        };
      }
      throw new Error("2 ページ目を取得してはいけない");
    });
    const oct = fakeOctokit({ list });
    const gh = createGhClient(oct as unknown as OctokitLike);
    const prs = await gh.listMergedPullRequests("o/r", { since: "2026-07-03T00:00:00Z" });
    expect(prs.map((p) => p.number)).toEqual([20]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("since 境界は >=(同時刻を含む)", async () => {
    const list: ListFn = async () => ({
      data: [
        prRow({
          number: 30,
          merged_at: "2026-07-03T00:00:00Z",
          updated_at: "2026-07-03T00:00:00Z",
        }),
      ],
    });
    const oct = fakeOctokit({ list });
    const gh = createGhClient(oct as unknown as OctokitLike);
    const prs = await gh.listMergedPullRequests("o/r", { since: "2026-07-03T00:00:00Z" });
    expect(prs.map((p) => p.number)).toEqual([30]);
  });

  it("フルページが続く限りページングし、maxPages で打ち切る", async () => {
    const list = vi.fn<ListFn>(async (p) => ({
      data: Array.from({ length: p.per_page ?? 100 }, (_, i) =>
        prRow({ number: (p.page ?? 1) * 1000 + i }),
      ),
    }));
    const oct = fakeOctokit({ list });
    const gh = createGhClient(oct as unknown as OctokitLike);
    const prs = await gh.listMergedPullRequests("o/r", {
      since: "2026-01-01T00:00:00Z",
      perPage: 2,
      maxPages: 3,
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(prs).toHaveLength(6); // 2 件 × 3 ページ
  });

  it("body/author の欠落は '' / null に正規化する", async () => {
    const list: ListFn = async () => ({
      data: [prRow({ number: 40, body: null, user: null })],
    });
    const oct = fakeOctokit({ list });
    const gh = createGhClient(oct as unknown as OctokitLike);
    const prs = await gh.listMergedPullRequests("o/r", { since: "2026-07-01T00:00:00Z" });
    expect(prs[0]).toMatchObject({ body: "", author: null });
  });

  it("API エラーは API_ERROR", async () => {
    const oct = fakeOctokit();
    oct.rest.pulls.list.mockRejectedValueOnce({ status: 500 });
    const gh = createGhClient(oct as unknown as OctokitLike);
    await expect(
      gh.listMergedPullRequests("o/r", { since: "2026-07-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "API_ERROR" });
  });
});

describe("listPullRequestComments", () => {
  it("会話コメントと diff 行コメントを統合し createdAt 昇順で返す", async () => {
    const listComments: IssueCommentsFn = async () => ({
      data: [{ body: "会話2", created_at: "2026-07-05T10:00:00Z", user: { login: "a" } }],
    });
    const listReviewComments: ReviewCommentsFn = async () => ({
      data: [
        { body: "行1", path: "src/x.ts", created_at: "2026-07-05T09:00:00Z", user: { login: "b" } },
      ],
    });
    const oct = fakeOctokit({ listComments, listReviewComments });
    const gh = createGhClient(oct as unknown as OctokitLike);
    const comments = await gh.listPullRequestComments("o/r", 7);
    expect(comments).toEqual([
      {
        kind: "review",
        author: "b",
        body: "行1",
        createdAt: "2026-07-05T09:00:00Z",
        path: "src/x.ts",
      },
      { kind: "issue", author: "a", body: "会話2", createdAt: "2026-07-05T10:00:00Z" },
    ]);
  });

  it("404 は NOT_FOUND", async () => {
    const oct = fakeOctokit();
    oct.rest.issues.listComments.mockRejectedValueOnce({ status: 404 });
    const gh = createGhClient(oct as unknown as OctokitLike);
    await expect(gh.listPullRequestComments("o/r", 7)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("listPullRequestFiles", () => {
  it("path/status/±行数のみを返す(patch は含まない)", async () => {
    const listFiles: ListFilesFn = async () => ({
      data: [
        { filename: "src/a.ts", status: "modified", additions: 10, deletions: 3 },
        { filename: "src/b.ts", status: "added", additions: 20, deletions: 0 },
      ],
    });
    const oct = fakeOctokit({ listFiles });
    const gh = createGhClient(oct as unknown as OctokitLike);
    const files = await gh.listPullRequestFiles("o/r", 7);
    expect(files).toEqual([
      { path: "src/a.ts", status: "modified", additions: 10, deletions: 3 },
      { path: "src/b.ts", status: "added", additions: 20, deletions: 0 },
    ]);
    // patch フィールドが型にも値にも無いこと(diff 非知識化)
    expect(Object.keys(files[0] ?? {})).not.toContain("patch");
  });

  it("404 は NOT_FOUND", async () => {
    const oct = fakeOctokit();
    oct.rest.pulls.listFiles.mockRejectedValueOnce({ status: 404 });
    const gh = createGhClient(oct as unknown as OctokitLike);
    await expect(gh.listPullRequestFiles("o/r", 7)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
