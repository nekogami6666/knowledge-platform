/**
 * commit evidence コレクタ(ADR-0017 D2)。対象リポの直近 window_days の commit を
 * gh-client の listCommits(GitHub API)で読み、author login 別に集計する。
 * email→人物の写像はしない — login が引けない commit は集計から除外し、
 * unattributedCommits としてレポートに列挙する(silent drop しない)。
 * リポ単位で失敗を隔離する(1 リポの権限ミスで全体を落とさない。pr-miner run.ts と同方針)。
 */
import type { GhClient } from "@stratum/gh-client";
import { laterDate, type MaterialEvidence, type PersonActivity } from "./evidence.js";
import type { Logger } from "./logger.js";

export interface CommitCollectorResult {
  materials: MaterialEvidence[];
  /** author login が引けなかった commit 数(リポ別)。 */
  unattributedCommits: Record<string, number>;
  /** 取得に失敗したリポ("そのリポだけ空振り"をレポートに出すため)。 */
  failedRepos: string[];
}

export async function collectCommitEvidence(
  targets: readonly string[],
  gh: Pick<GhClient, "listCommits">,
  since: string,
  logger: Pick<Logger, "warn" | "info">,
): Promise<CommitCollectorResult> {
  const materials: MaterialEvidence[] = [];
  const unattributedCommits: Record<string, number> = {};
  const failedRepos: string[] = [];

  for (const repo of targets) {
    let commits: Awaited<ReturnType<GhClient["listCommits"]>>;
    try {
      commits = await gh.listCommits(repo, { since });
    } catch (err) {
      failedRepos.push(repo);
      logger.warn("commit の取得に失敗したためこのリポをスキップします(権限を確認)", {
        repo,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const people = new Map<string, PersonActivity>();
    let unattributed = 0;
    for (const c of commits) {
      if (c.author === null || c.authoredAt === "") {
        unattributed += 1;
        continue;
      }
      const day = c.authoredAt.slice(0, 10); // ISO 8601 → dateOnly
      const cur = people.get(c.author);
      people.set(
        c.author,
        cur === undefined
          ? { person: c.author, count: 1, lastActive: day }
          : { person: c.author, count: cur.count + 1, lastActive: laterDate(cur.lastActive, day) },
      );
    }
    if (unattributed > 0) unattributedCommits[repo] = unattributed;
    // 全 commit が author 不明なら material を作らない(people 空の topic は表現できない・§4.5)。
    if (people.size > 0) {
      materials.push({
        material: { id: `repo:${repo}`, kind: "repo", repo },
        people: [...people.values()],
      });
    }
    logger.info("commit evidence を集計しました", {
      repo,
      commits: commits.length,
      people: people.size,
      unattributed,
    });
  }
  return { materials, unattributedCommits, failedRepos };
}
