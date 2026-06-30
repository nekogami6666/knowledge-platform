/**
 * GitHub クライアント(design.md §6 のバッチ群が knowledge-base に PR を書くための薄いラッパ)。
 * Octokit は {@link OctokitLike} 注入 seam の背後に置き(kb-core IdCounterStore / llm queryFn と同趣旨)、
 * ユニットテストは fake Octokit で鍵・ネットワーク不要にする。
 * リポジトリ名はすべて引数で受け取る(ハードコード禁止・CLAUDE.md §12.2)。
 */
import { createOctokit, type GhAuth, resolveGhAuthFromEnv } from "./auth.js";
import { GhClientError } from "./errors.js";

/** PR に含める1ファイルの変更(新規・更新どちらも content 全文で表す)。 */
export interface FileChange {
  /** repo ルートからの相対パス(POSIX)。 */
  path: string;
  /** ファイル全文(UTF-8)。 */
  content: string;
}

export interface CreatePrOptions {
  /** "org/name"。 */
  repo: string;
  /** 作成するブランチ名(例 `extract/2026-06-30`)。 */
  head: string;
  title: string;
  body: string;
  /** 1コミットにまとめて入れるファイル群。 */
  files: readonly FileChange[];
  /** ベースブランチ。既定 "main"。 */
  base?: string;
}

export interface PrSummary {
  number: number;
  title: string;
  headRef: string;
  url: string;
}

export interface ListPrOptions {
  state?: "open" | "closed" | "all";
  perPage?: number;
}

export interface MergePrOptions {
  repo: string;
  number: number;
  method?: "merge" | "squash" | "rebase";
  commitTitle?: string;
}

export interface GetFileOptions {
  repo: string;
  path: string;
  ref?: string;
}

/** gh-client が公開する最小操作(F1 extractor / 将来の bot 自動マージが消費)。 */
export interface GhClient {
  /** 複数ファイルを1コミットにまとめた PR を作成する(Git Data API)。 */
  createPullRequest(opts: CreatePrOptions): Promise<{ number: number; url: string }>;
  /** PR 一覧(冪等性=タイトル走査用)。 */
  listPullRequests(repo: string, opts?: ListPrOptions): Promise<PrSummary[]>;
  /** PR をマージする(既定 squash)。 */
  mergePullRequest(opts: MergePrOptions): Promise<void>;
  /** ファイル内容と blob SHA を取得する。存在しなければ null(id-allocator CAS 用)。 */
  getFileContents(opts: GetFileOptions): Promise<{ content: string; sha: string } | null>;
}

interface TreeItem {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string;
}

/**
 * client.ts が消費する Octokit REST の部分集合(注入 seam)。
 * 実 Octokit はこの構造的部分集合を満たすため createGhClientFromAuth でそのまま渡せる。
 */
export interface OctokitLike {
  rest: {
    git: {
      getRef(p: { owner: string; repo: string; ref: string }): Promise<{
        data: { object: { sha: string } };
      }>;
      createBlob(p: { owner: string; repo: string; content: string; encoding: string }): Promise<{
        data: { sha: string };
      }>;
      createTree(p: {
        owner: string;
        repo: string;
        base_tree: string;
        tree: TreeItem[];
      }): Promise<{ data: { sha: string } }>;
      createCommit(p: {
        owner: string;
        repo: string;
        message: string;
        tree: string;
        parents: string[];
      }): Promise<{ data: { sha: string } }>;
      createRef(p: { owner: string; repo: string; ref: string; sha: string }): Promise<{
        data: unknown;
      }>;
    };
    pulls: {
      create(p: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
      }): Promise<{ data: { number: number; html_url: string } }>;
      list(p: { owner: string; repo: string; state?: string; per_page?: number }): Promise<{
        data: Array<{ number: number; title: string; head: { ref: string }; html_url: string }>;
      }>;
      merge(p: {
        owner: string;
        repo: string;
        pull_number: number;
        merge_method?: string;
        commit_title?: string;
      }): Promise<{ data: unknown }>;
    };
    repos: {
      getContent(p: { owner: string; repo: string; path: string; ref?: string }): Promise<{
        data: unknown;
      }>;
    };
  };
}

/** "org/name" を {owner, repo} に分解する。形式不正は GhClientError。 */
export function splitRepo(repo: string): { owner: string; repo: string } {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
  const owner = m?.[1];
  const name = m?.[2];
  if (owner === undefined || name === undefined) {
    throw new GhClientError("API_ERROR", `repo は "org/name" 形式で指定してください: ${repo}`);
  }
  return { owner, repo: name };
}

function statusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/** Octokit を注入して {@link GhClient} を組み立てる(テストは fake を渡す)。 */
export function createGhClient(octokit: OctokitLike): GhClient {
  return {
    async createPullRequest(opts) {
      const { owner, repo } = splitRepo(opts.repo);
      const base = opts.base ?? "main";
      try {
        const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
        const baseSha = baseRef.data.object.sha;
        const tree: TreeItem[] = [];
        for (const f of opts.files) {
          const blob = await octokit.rest.git.createBlob({
            owner,
            repo,
            content: Buffer.from(f.content, "utf8").toString("base64"),
            encoding: "base64",
          });
          tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.data.sha });
        }
        const treeRes = await octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: baseSha,
          tree,
        });
        const commit = await octokit.rest.git.createCommit({
          owner,
          repo,
          message: opts.title,
          tree: treeRes.data.sha,
          parents: [baseSha],
        });
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${opts.head}`,
          sha: commit.data.sha,
        });
        const pr = await octokit.rest.pulls.create({
          owner,
          repo,
          title: opts.title,
          body: opts.body,
          head: opts.head,
          base,
        });
        return { number: pr.data.number, url: pr.data.html_url };
      } catch (e) {
        if (e instanceof GhClientError) throw e;
        const code = statusOf(e) === 409 || statusOf(e) === 422 ? "CONFLICT" : "API_ERROR";
        throw new GhClientError(code, `PR 作成に失敗しました(${opts.repo} ${opts.head})`, {
          cause: e,
        });
      }
    },

    async listPullRequests(repo, opts) {
      const { owner, repo: name } = splitRepo(repo);
      try {
        const res = await octokit.rest.pulls.list({
          owner,
          repo: name,
          state: opts?.state ?? "open",
          per_page: opts?.perPage ?? 30,
        });
        return res.data.map((p) => ({
          number: p.number,
          title: p.title,
          headRef: p.head.ref,
          url: p.html_url,
        }));
      } catch (e) {
        throw new GhClientError("API_ERROR", `PR 一覧の取得に失敗しました(${repo})`, { cause: e });
      }
    },

    async mergePullRequest(opts) {
      const { owner, repo } = splitRepo(opts.repo);
      try {
        await octokit.rest.pulls.merge({
          owner,
          repo,
          pull_number: opts.number,
          merge_method: opts.method ?? "squash",
          commit_title: opts.commitTitle,
        });
      } catch (e) {
        const code = statusOf(e) === 409 ? "CONFLICT" : "API_ERROR";
        throw new GhClientError(code, `PR マージに失敗しました(${opts.repo}#${opts.number})`, {
          cause: e,
        });
      }
    },

    async getFileContents(opts) {
      const { owner, repo } = splitRepo(opts.repo);
      try {
        const res = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: opts.path,
          ref: opts.ref,
        });
        const data = res.data;
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          throw new GhClientError("API_ERROR", `ファイルではありません: ${opts.path}`);
        }
        const d = data as { type?: string; content?: string; encoding?: string; sha?: string };
        if (d.type !== "file" || typeof d.content !== "string" || typeof d.sha !== "string") {
          throw new GhClientError("API_ERROR", `ファイルではありません: ${opts.path}`);
        }
        const encoding: BufferEncoding = d.encoding === "base64" ? "base64" : "utf8";
        return { content: Buffer.from(d.content, encoding).toString("utf8"), sha: d.sha };
      } catch (e) {
        if (statusOf(e) === 404) return null;
        if (e instanceof GhClientError) throw e;
        throw new GhClientError("API_ERROR", `ファイル取得に失敗しました: ${opts.path}`, {
          cause: e,
        });
      }
    },
  };
}

/** {@link GhAuth} から実 Octokit を生成して {@link GhClient} を組み立てる。 */
export function createGhClientFromAuth(auth: GhAuth): GhClient {
  return createGhClient(createOctokit(auth) as unknown as OctokitLike);
}

/** env(App trio か GITHUB_TOKEN)から {@link GhClient} を組み立てる。 */
export function createGhClientFromEnv(
  source: Record<string, string | undefined> = process.env,
): GhClient {
  return createGhClientFromAuth(resolveGhAuthFromEnv(source));
}
