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

/** PR の現在状態(bot 代理マージの事前確認用・§6.3)。 */
export interface PrDetail {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  /**
   * GitHub の mergeable_state("clean"=チェック緑・競合なし、"dirty"=競合、"blocked"=保護ルール、
   * "unstable"=チェック失敗あり 等)。算出中は null。マージ可否の判断は "clean" のみを可とする(ADR-0004 D2)。
   */
  mergeableState: string | null;
  title: string;
  url: string;
}

export interface GetFileOptions {
  repo: string;
  path: string;
  ref?: string;
}

/** 既存ブランチへ複数ファイルを1コミットで積むオプション(§6.5 質問ログの直接 commit 用)。 */
export interface CommitFilesOptions {
  /** "org/name"。 */
  repo: string;
  /** commit 先の既存ブランチ(例 "main")。 */
  branch: string;
  message: string;
  files: readonly FileChange[];
  /** 同じ commit で削除するパス(open→answered の移動等・§6.5)。既定なし。 */
  deletions?: readonly string[];
}

/** マージ済み PR の列挙オプション(§6.4 ③-c pr-miner)。 */
export interface ListMergedPrOptions {
  /** この時刻以降にマージされた PR のみ返す(ISO 8601)。カーソル由来。 */
  since: string;
  /** 1 ページの取得件数。既定 100(GitHub 上限)。 */
  perPage?: number;
  /** ページングの安全上限(暴走防止)。既定 10。 */
  maxPages?: number;
}

/** マージ済み PR の要約(pr-miner の抽出入力・§6.4 ③-c)。 */
export interface MergedPrSummary {
  number: number;
  title: string;
  /** PR 本文(null は "" に正規化)。 */
  body: string;
  /** 作成者の GitHub ユーザ名(取得不能は null)。 */
  author: string | null;
  /** マージ時刻(ISO 8601)。 */
  mergedAt: string;
  url: string;
}

/** PR のコメント1件(会話 or diff 行コメント)。 */
export interface PrCommentItem {
  /** "issue"=会話タブのコメント、"review"=diff 行に付いたレビューコメント。 */
  kind: "issue" | "review";
  author: string | null;
  body: string;
  createdAt: string | null;
  /** review コメントの対象ファイル(issue コメントは undefined)。 */
  path?: string;
}

/**
 * PR で変更されたファイルの要約(§6.4 ③-c: diff サマリのみ)。
 * patch(diff 本文)は**あえて持たない** — 「コードは Git にある。判断と理由だけを取る」を型で担保する。
 */
export interface PrFileSummary {
  path: string;
  /** "added" / "modified" / "removed" / "renamed" 等。 */
  status: string;
  additions: number;
  deletions: number;
}

export interface ListCommitsOptions {
  /** この時刻以降の commit のみ返す(ISO 8601)。 */
  since: string;
  /** この時刻以前に限定(ISO 8601・任意)。 */
  until?: string;
  /** 1 ページの取得件数。既定 100(GitHub 上限)。 */
  perPage?: number;
  /** ページングの安全上限(暴走防止)。既定 10。 */
  maxPages?: number;
}

/** commit の要約(§6.6 ⑤-a expertise-mapper の evidence 入力)。diff・メッセージ本文は持たない。 */
export interface CommitSummary {
  sha: string;
  /**
   * GitHub アカウントに紐づく author login。未紐付け(メールが GitHub に登録されていない等)は null
   * (email→人物の写像はしない・ADR-0017 D2。null は呼び出し側が「author 不明」として集計から除外)。
   */
  author: string | null;
  /** commit author date(ISO 8601。rebase でも保存される側)。 */
  authoredAt: string;
}

/** gh-client が公開する最小操作(F1 extractor / bot 代理マージ / C5 gap-tracker が消費)。 */
export interface GhClient {
  /** 複数ファイルを1コミットにまとめた PR を作成する(Git Data API)。 */
  createPullRequest(opts: CreatePrOptions): Promise<{ number: number; url: string }>;
  /** PR 一覧(冪等性=タイトル走査用)。 */
  listPullRequests(repo: string, opts?: ListPrOptions): Promise<PrSummary[]>;
  /** PR をマージする(既定 squash)。 */
  mergePullRequest(opts: MergePrOptions): Promise<void>;
  /** PR の現在状態を取得する(マージ前の clean 確認・冪等判定用)。404 は NOT_FOUND。 */
  getPullRequest(repo: string, number: number): Promise<PrDetail>;
  /**
   * 既存ブランチへ複数ファイルを1コミットで積む(Git Data API + updateRef)。
   * §6.5: questions/open のログ commit 用(PR を経ない。呼び出し側が事前に validateRepo で防御する)。
   * ブランチ先端が動いた場合の updateRef 失敗(non-fast-forward)は CONFLICT。
   */
  commitFiles(opts: CommitFilesOptions): Promise<{ sha: string }>;
  /** ファイル内容と blob SHA を取得する。存在しなければ null(id-allocator CAS 用)。 */
  getFileContents(opts: GetFileOptions): Promise<{ content: string; sha: string } | null>;
  /**
   * `since` 以降にマージされた PR を新しい順に列挙する(§6.4 ③-c pr-miner)。
   * closed PR を updated 降順でページングし、`updated_at < since` で打ち切る
   * (merged_at ≤ updated_at のため取りこぼさない)。未マージ close は除外。
   */
  listMergedPullRequests(repo: string, opts: ListMergedPrOptions): Promise<MergedPrSummary[]>;
  /** PR の会話コメント + diff 行レビューコメントを統合して時系列で返す。404 は NOT_FOUND。 */
  listPullRequestComments(repo: string, number: number): Promise<PrCommentItem[]>;
  /** PR の変更ファイル要約(path/status/±行数のみ。diff 本文は取らない)。404 は NOT_FOUND。 */
  listPullRequestFiles(repo: string, number: number): Promise<PrFileSummary[]>;
  /**
   * 既定ブランチの commit を `since` 以降で列挙する(§6.6 ⑤-a expertise-mapper の evidence)。
   * author は GitHub アカウント紐づきの login のみ(email 写像はしない・ADR-0017 D2)。
   */
  listCommits(repo: string, opts: ListCommitsOptions): Promise<CommitSummary[]>;
}

interface TreeItem {
  path: string;
  mode: "100644";
  type: "blob";
  /** blob SHA。null は Git Data API でそのパスを削除する(ファイル移動の open→answered 等・§6.5)。 */
  sha: string | null;
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
      updateRef(p: { owner: string; repo: string; ref: string; sha: string }): Promise<{
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
      // 追加フィールドはすべて optional。既存 fake(listPullRequests 用)を壊さない(§6.4 ③-c)。
      list(p: {
        owner: string;
        repo: string;
        state?: string;
        sort?: string;
        direction?: string;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          number: number;
          title: string;
          head: { ref: string };
          html_url: string;
          body?: string | null;
          merged_at?: string | null;
          updated_at?: string;
          user?: { login: string } | null;
        }>;
      }>;
      merge(p: {
        owner: string;
        repo: string;
        pull_number: number;
        merge_method?: string;
        commit_title?: string;
      }): Promise<{ data: unknown }>;
      get(p: { owner: string; repo: string; pull_number: number }): Promise<{
        data: {
          number: number;
          state: string;
          merged: boolean;
          mergeable_state?: string | null;
          title: string;
          html_url: string;
        };
      }>;
      listReviewComments(p: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          body?: string | null;
          path?: string;
          created_at?: string | null;
          user?: { login: string } | null;
        }>;
      }>;
      listFiles(p: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{ filename: string; status: string; additions: number; deletions: number }>;
      }>;
    };
    issues: {
      listComments(p: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          body?: string | null;
          created_at?: string | null;
          user?: { login: string } | null;
        }>;
      }>;
    };
    repos: {
      getContent(p: { owner: string; repo: string; path: string; ref?: string }): Promise<{
        data: unknown;
      }>;
      listCommits(p: {
        owner: string;
        repo: string;
        since: string;
        until?: string;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          sha: string;
          author?: { login: string } | null;
          commit: { author?: { date?: string } | null };
        }>;
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

/** baseSha の上に files を1コミットとして積み、その commit SHA を返す(Git Data API 共通配管)。 */
async function buildCommit(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  baseSha: string,
  files: readonly FileChange[],
  message: string,
  deletions: readonly string[] = [],
): Promise<string> {
  const tree: TreeItem[] = [];
  for (const f of files) {
    const blob = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: Buffer.from(f.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.data.sha });
  }
  // sha: null で base_tree から当該パスを削除する(open→answered のようなファイル移動用・§6.5)。
  for (const path of deletions) {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }
  const treeRes = await octokit.rest.git.createTree({ owner, repo, base_tree: baseSha, tree });
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: treeRes.data.sha,
    parents: [baseSha],
  });
  return commit.data.sha;
}

/** Octokit を注入して {@link GhClient} を組み立てる(テストは fake を渡す)。 */
export function createGhClient(octokit: OctokitLike): GhClient {
  return {
    async createPullRequest(opts) {
      const { owner, repo } = splitRepo(opts.repo);
      const base = opts.base ?? "main";
      try {
        const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
        const commitSha = await buildCommit(
          octokit,
          owner,
          repo,
          baseRef.data.object.sha,
          opts.files,
          opts.title,
        );
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${opts.head}`,
          sha: commitSha,
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

    async commitFiles(opts) {
      const { owner, repo } = splitRepo(opts.repo);
      try {
        const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${opts.branch}` });
        const commitSha = await buildCommit(
          octokit,
          owner,
          repo,
          ref.data.object.sha,
          opts.files,
          opts.message,
          opts.deletions ?? [],
        );
        // fast-forward 前提の updateRef(force しない)。先端が動いていたら 422 → CONFLICT。
        await octokit.rest.git.updateRef({
          owner,
          repo,
          ref: `heads/${opts.branch}`,
          sha: commitSha,
        });
        return { sha: commitSha };
      } catch (e) {
        if (e instanceof GhClientError) throw e;
        const code = statusOf(e) === 409 || statusOf(e) === 422 ? "CONFLICT" : "API_ERROR";
        throw new GhClientError(code, `commit に失敗しました(${opts.repo} ${opts.branch})`, {
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

    async getPullRequest(repo, number) {
      const { owner, repo: name } = splitRepo(repo);
      try {
        const res = await octokit.rest.pulls.get({ owner, repo: name, pull_number: number });
        const d = res.data;
        return {
          number: d.number,
          state: d.state === "closed" ? "closed" : "open",
          merged: d.merged,
          mergeableState: d.mergeable_state ?? null,
          title: d.title,
          url: d.html_url,
        };
      } catch (e) {
        const code = statusOf(e) === 404 ? "NOT_FOUND" : "API_ERROR";
        throw new GhClientError(code, `PR 取得に失敗しました(${repo}#${number})`, { cause: e });
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

    async listMergedPullRequests(repo, opts) {
      const { owner, repo: name } = splitRepo(repo);
      const perPage = opts.perPage ?? 100;
      const maxPages = opts.maxPages ?? 10;
      const out: MergedPrSummary[] = [];
      try {
        for (let page = 1; page <= maxPages; page++) {
          const res = await octokit.rest.pulls.list({
            owner,
            repo: name,
            state: "closed",
            sort: "updated",
            direction: "desc",
            per_page: perPage,
            page,
          });
          const rows = res.data;
          let reachedOld = false;
          for (const p of rows) {
            // updated 降順なので、since より古い更新に到達したら以降は全て対象外(早期打ち切り)。
            // merged_at ≤ updated_at のため、この判定で取りこぼしは起きない。
            if (p.updated_at !== undefined && p.updated_at < opts.since) {
              reachedOld = true;
              break;
            }
            const mergedAt = p.merged_at ?? null;
            if (mergedAt === null || mergedAt < opts.since) continue; // 未マージ close / 期間外
            out.push({
              number: p.number,
              title: p.title,
              body: p.body ?? "",
              author: p.user?.login ?? null,
              mergedAt,
              url: p.html_url,
            });
          }
          if (reachedOld || rows.length < perPage) break; // 打ち切り or 最終ページ
        }
        return out;
      } catch (e) {
        throw new GhClientError("API_ERROR", `マージ済み PR の列挙に失敗しました(${repo})`, {
          cause: e,
        });
      }
    },

    async listPullRequestComments(repo, number) {
      const { owner, repo: name } = splitRepo(repo);
      try {
        const items: PrCommentItem[] = [];
        // 会話タブ(issues.listComments)+ diff 行(pulls.listReviewComments)を統合する。
        for (let page = 1; ; page++) {
          const res = await octokit.rest.issues.listComments({
            owner,
            repo: name,
            issue_number: number,
            per_page: 100,
            page,
          });
          for (const c of res.data) {
            items.push({
              kind: "issue",
              author: c.user?.login ?? null,
              body: c.body ?? "",
              createdAt: c.created_at ?? null,
            });
          }
          if (res.data.length < 100) break;
        }
        for (let page = 1; ; page++) {
          const res = await octokit.rest.pulls.listReviewComments({
            owner,
            repo: name,
            pull_number: number,
            per_page: 100,
            page,
          });
          for (const c of res.data) {
            items.push({
              kind: "review",
              author: c.user?.login ?? null,
              body: c.body ?? "",
              createdAt: c.created_at ?? null,
              ...(c.path !== undefined ? { path: c.path } : {}),
            });
          }
          if (res.data.length < 100) break;
        }
        // createdAt 昇順(null は末尾)で時系列に並べる。
        items.sort((a, b) => (a.createdAt ?? "￿").localeCompare(b.createdAt ?? "￿"));
        return items;
      } catch (e) {
        const code = statusOf(e) === 404 ? "NOT_FOUND" : "API_ERROR";
        throw new GhClientError(code, `PR コメントの取得に失敗しました(${repo}#${number})`, {
          cause: e,
        });
      }
    },

    async listPullRequestFiles(repo, number) {
      const { owner, repo: name } = splitRepo(repo);
      try {
        const out: PrFileSummary[] = [];
        for (let page = 1; ; page++) {
          const res = await octokit.rest.pulls.listFiles({
            owner,
            repo: name,
            pull_number: number,
            per_page: 100,
            page,
          });
          for (const f of res.data) {
            out.push({
              path: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            });
          }
          if (res.data.length < 100) break;
        }
        return out;
      } catch (e) {
        const code = statusOf(e) === 404 ? "NOT_FOUND" : "API_ERROR";
        throw new GhClientError(code, `PR ファイル一覧の取得に失敗しました(${repo}#${number})`, {
          cause: e,
        });
      }
    },

    async listCommits(repo, opts) {
      const { owner, repo: name } = splitRepo(repo);
      const perPage = opts.perPage ?? 100;
      const maxPages = opts.maxPages ?? 10;
      const out: CommitSummary[] = [];
      try {
        for (let page = 1; page <= maxPages; page++) {
          const res = await octokit.rest.repos.listCommits({
            owner,
            repo: name,
            since: opts.since,
            ...(opts.until !== undefined ? { until: opts.until } : {}),
            per_page: perPage,
            page,
          });
          for (const c of res.data) {
            out.push({
              sha: c.sha,
              author: c.author?.login ?? null,
              // API 上 commit.author.date は常に入る(型が optional なだけ)。防御的に "" フォールバック。
              authoredAt: c.commit.author?.date ?? "",
            });
          }
          if (res.data.length < perPage) break; // 最終ページ
        }
        return out;
      } catch (e) {
        throw new GhClientError("API_ERROR", `commit の列挙に失敗しました(${repo})`, {
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
