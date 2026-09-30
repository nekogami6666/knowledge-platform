/**
 * /ask の検索範囲の決定(ADR-0036 D1〜D5)。純関数(I/O なし)。
 * repos.yaml の手動指定(`repos:`)と、`all_visible` による org 可視リポの列挙結果
 * (gh-client の listOrgRepos)から、同期・検索する対象リポの一覧を作る。
 *
 * - all_visible が null: 手動指定をそのまま返す(全件 /ask ごとに同期 = 従来挙動)。
 * - 列挙分: アーカイブ・フォーク・exclude を除く(D2 / D3)。url はトークン無し
 *   (実行時に withCloneToken で注入する。/config はエージェント可視のため平文トークンを持たない)。
 * - 手動指定が常に優先(D1)。同じ repo の列挙分は重複として捨て、同じ dir の列挙分は
 *   clone 先の衝突として捨てる。
 * - exclude は**列挙分にだけ効く**。手動指定は明示の意図なので exclude に載っていても残す
 *   (外したいなら repos: から消す)。
 */
import type { OrgRepo } from "@stratum/gh-client";
import type { RepoSpec } from "./repos.js";

/** 検索範囲に入った1リポ(RepoSpec + 同期方針・由来)。 */
export interface ScopedRepo extends RepoSpec {
  // description(GitHub の説明・manifest 用)は RepoSpec 側に持つ(ADR-0036 D6)。
  /** true = /ask のたびに同期、false = 定期のバックグラウンド同期のみ(D5)。 */
  syncOnAsk: boolean;
  /** true = all_visible の列挙由来(対象外になれば clone 削除の対象・D4)、false = repos: の手動指定。 */
  managed: boolean;
}

/** 列挙から外したリポと理由(ログ・観測用)。 */
export interface ExcludedRepo {
  /** "org/name"。 */
  repo: string;
  /** conflict = 手動指定と dir が衝突、または dir 名として安全でない。 */
  reason: "archived" | "fork" | "exclude" | "conflict";
}

/** resolveRepoScope に渡す all_visible 設定(config.ts の AllVisibleConfig と同形)。 */
export interface RepoScopeAllVisible {
  org: string;
  exclude: readonly string[];
  sync_on_ask: readonly string[];
}

export interface RepoScopeInput {
  manual: readonly RepoSpec[];
  allVisible: RepoScopeAllVisible | null;
  /** listOrgRepos(org) の結果。allVisible が null のときは無視する。 */
  visible: readonly OrgRepo[];
}

export interface RepoScope {
  /** 手動指定(与えた順)→ 列挙分(name 昇順)の順。 */
  repos: ScopedRepo[];
  /** 列挙から外したもの(name 昇順)。手動指定と同じ repo の重複は含めない。 */
  excluded: ExcludedRepo[];
}

/** リポ名パターン("name" or "org/name")が当てはまるか。`*` のみの簡易 glob・大小無視。 */
function matchesPattern(pattern: string, repo: OrgRepo): boolean {
  const target = pattern.includes("/") ? repo.fullName : repo.name;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  );
  return re.test(target);
}

/** exclude の照合("name" or "org/name"・大小無視の完全一致。glob は使わない)。 */
function isExcluded(exclude: readonly string[], repo: OrgRepo): boolean {
  const name = repo.name.toLowerCase();
  const full = repo.fullName.toLowerCase();
  return exclude.some((e) => {
    const x = e.toLowerCase();
    return x === name || x === full;
  });
}

/** clonesDir 直下の1セグメントとして安全な dir 名か(GitHub の名前では実際には起きない防御)。 */
function isSafeDir(dir: string): boolean {
  return dir.length > 0 && !dir.includes("/") && !dir.includes("\\") && !dir.startsWith(".");
}

function byName(a: OrgRepo, b: OrgRepo): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 手動指定と all_visible の列挙から検索範囲を決める(ADR-0036)。 */
export function resolveRepoScope(input: RepoScopeInput): RepoScope {
  const { manual, allVisible } = input;
  if (allVisible === null) {
    return { repos: manual.map((r) => ({ ...r, syncOnAsk: true, managed: false })), excluded: [] };
  }

  const visible = [...input.visible].sort(byName);
  const visibleByRepo = new Map(visible.map((v) => [v.fullName.toLowerCase(), v]));
  const manualRepos = new Set(manual.map((r) => r.repo.toLowerCase()));
  // clone 先の衝突は大小無視で判定する(大小を区別しない FS でも同じ dir にならないように)。
  const manualDirs = new Set(manual.map((r) => r.dir.toLowerCase()));

  const repos: ScopedRepo[] = manual.map((r) => {
    const description = visibleByRepo.get(r.repo.toLowerCase())?.description ?? null;
    return {
      ...r,
      ...(description !== null ? { description } : {}),
      syncOnAsk: true,
      managed: false,
    };
  });
  const excluded: ExcludedRepo[] = [];

  for (const v of visible) {
    // 手動指定と同じ repo は重複(手動側が優先)。除外扱いにはしない。
    if (manualRepos.has(v.fullName.toLowerCase())) continue;
    const reason: ExcludedRepo["reason"] | null = v.archived
      ? "archived"
      : v.fork
        ? "fork"
        : isExcluded(allVisible.exclude, v)
          ? "exclude"
          : !isSafeDir(v.name) || manualDirs.has(v.name.toLowerCase())
            ? "conflict"
            : null;
    if (reason !== null) {
      excluded.push({ repo: v.fullName, reason });
      continue;
    }
    repos.push({
      repo: v.fullName,
      dir: v.name,
      url: `https://github.com/${v.fullName}.git`,
      ...(v.description !== null ? { description: v.description } : {}),
      syncOnAsk: allVisible.sync_on_ask.some((p) => matchesPattern(p, v)),
      managed: true,
    });
  }
  return { repos, excluded };
}
