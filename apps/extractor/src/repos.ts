/**
 * minutes / knowledge-base の clone 同期(design.md §6.3 step1)。git 実行は注入 seam。
 * url 指定時は clone/fetch+reset、未指定時は既に checkout 済みの dir を使う(workflow が fetch-depth:0 で配置)。
 * これは合成根(index.ts)向けのグルー。ユニットテストでは fake syncer を注入する。
 *
 * 認証(ADR-0013 / ADR-0006): url にトークンが含まれても **.git/config に永続化しない**。
 * clone 直後に remote URL をトークン無しへ差し替え、fetch は URL を引数で渡す(origin 参照しない)。
 * reconcile の agentic Read が clone 配下の .git/config を読んでもトークンが漏れないようにする。
 */
import { join } from "node:path";
import type { ExtractorConfig, RepoSpec } from "./config.js";
import type { GitExec } from "./diff.js";

export interface SyncedRepo {
  repo: string;
  absDir: string;
  resolvedCommit: string;
}

export interface RepoSyncer {
  sync(): Promise<{ minutes: SyncedRepo; kb: SyncedRepo }>;
}

/** https URL から userinfo(user:token@)を除去する(ログ・.git/config 残留対策)。 */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

export function createGitRepoSyncer(
  config: ExtractorConfig,
  clonesDir: string,
  exec: GitExec,
): RepoSyncer {
  const syncOne = async (spec: RepoSpec, baseBranch: string): Promise<SyncedRepo> => {
    const absDir = join(clonesDir, spec.dir);
    let isRepo = true;
    try {
      await exec(["rev-parse", "--is-inside-work-tree"], absDir);
    } catch {
      isRepo = false;
    }
    if (isRepo) {
      if (spec.url !== undefined) {
        // URL を引数で渡す(origin の保存 URL に依存しない=トークンを config に書かずに済む)。
        await exec(["fetch", spec.url, baseBranch], absDir);
        await exec(["reset", "--hard", "FETCH_HEAD"], absDir);
      }
    } else {
      if (spec.url === undefined) {
        throw new Error(`clone 先が存在せず url も未指定です: ${spec.dir}`);
      }
      await exec(["clone", spec.url, spec.dir], clonesDir);
      // clone は origin にトークン含み URL を書くため、即座にトークン無しへ差し替える(ADR-0013)。
      await exec(["remote", "set-url", "origin", stripCredentials(spec.url)], absDir);
    }
    const { stdout } = await exec(["rev-parse", "HEAD"], absDir);
    return { repo: spec.repo, absDir, resolvedCommit: stdout.trim() };
  };
  return {
    async sync() {
      return {
        minutes: await syncOne(config.minutes, config.base_branch),
        kb: await syncOne(config.kb, config.base_branch),
      };
    },
  };
}
