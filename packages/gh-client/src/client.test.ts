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

function fakeOctokit(over: { getContent?: GetContentFn } = {}) {
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
        list: vi.fn(async () => ({
          data: [
            {
              number: 7,
              title: "Extract: a..b",
              head: { ref: "extract/x" },
              html_url: "https://github.com/o/r/pull/7",
            },
          ],
        })),
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
