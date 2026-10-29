/**
 * System One 判定層の入口(ADR-0041)。/ask の同期後・検索前に呼ばれ、候補ブロック(ユーザープロンプトの前置き)を返す。
 *
 * - runSystemOne: カタログと質問から状態を作り(retrieve)、判定し(decide)、ゲートして候補ブロックを組む。
 *   時間予算(weights.budgetMs)を超えたら前置き無し(budget)。evals からも同じ関数を使う。
 * - createSystemOne: bot 用のフック。カタログのキャッシュ(リポ + HEAD)・判定の記録(bot.db)・モード
 *   (on = 前置きする / shadow = 判定と記録だけ)を持つ。**例外を外へ出さない**(失敗は前置き無しで検索を続ける)。
 *
 * ask.ts への配線は数行に留め、ロジックはこのディレクトリに閉じる。
 */
import { relative, sep } from "node:path";
import type { SystemOneDecisionStore } from "../db.js";
import type { SyncedRepo } from "../repos.js";
import { type BlockItem, buildCandidateBlock } from "./block.js";
import { type Catalog, type CatalogCache, createCatalogCache } from "./catalog.js";
import { type Decisions, decide, gateOf, type SystemOneDecider } from "./decide.js";
import {
  buildState,
  type Candidate,
  type DiscordCandidateSource,
  type SystemOneState,
} from "./retrieve.js";
import { loadDefaultWeights, type SystemOneWeights } from "./weights.js";

export { withPromptPrefix } from "./block.js";
export {
  buildRepoCatalog,
  type Catalog,
  type CatalogEntry,
  classifyPath,
  createCatalogCache,
} from "./catalog.js";
export {
  type Decisions,
  decide,
  type Explanation,
  explain,
  type FeatureMap,
  gateOf,
  linear,
  ordinalLevels,
  type SystemOneDecider,
  sigmoid,
  softmax,
} from "./decide.js";
export {
  buildState,
  CANDIDATE_FEATURES,
  type Candidate,
  type DiscordCandidateDoc,
  type DiscordCandidateSource,
  type SystemOneState,
} from "./retrieve.js";
export {
  loadDefaultWeights,
  parseSystemOneWeights,
  SOURCE_KINDS,
  type SourceKind,
  type SystemOneWeights,
  systemOneWeightsSchema,
} from "./weights.js";

/** /ask の System One のモード(env ASK_FASTPATH・ADR-0041 D8)。 */
export type FastpathMode = "off" | "shadow" | "on";

/** 判定の結果段階(記録用)。budget = 時間予算超過、catalog_wait = カタログ作成待ちの上限超過、error = 例外。 */
export type SystemOneOutcome = "high" | "mid" | "low" | "budget" | "catalog_wait" | "error";

export interface SystemOneRun {
  state: SystemOneState;
  decisions: Decisions;
  gate: "high" | "mid" | "low" | "budget";
  /** 期待値の降順の候補(ゲートで載せる件数に絞る前)。 */
  ranked: { candidate: Candidate; expected: number }[];
  /** ブロックに載せた候補(low / budget なら空)。 */
  shown: { candidate: Candidate; expected: number }[];
  /** 前置き(low / budget なら null)。 */
  block: string | null;
  elapsedMs: number;
}

export interface RunSystemOneInput {
  question: string;
  catalog: Catalog;
  weights: SystemOneWeights;
  /** 壁時計 ms(時間表現・鮮度の「今」)。 */
  nowMs: number;
  /** 単調クロック ms(時間予算)。既定 performance.now。 */
  monotonicMs?: () => number;
  discord?: DiscordCandidateSource;
  decider?: SystemOneDecider;
  /** repo → エージェントの cwd からの相対ディレクトリ(読むパスの表示)。無ければ repo/path だけ出す。 */
  dirOf?: (repo: string) => string | null;
}

/** カタログと質問から判定し、ゲートして候補ブロックを組む(evals と bot で共用)。 */
export async function runSystemOne(input: RunSystemOneInput): Promise<SystemOneRun> {
  const mono = input.monotonicMs ?? (() => performance.now());
  const w = input.weights;
  const t0 = mono();
  const state = await buildState({
    question: input.question,
    catalog: input.catalog,
    nowMs: input.nowMs,
    monotonicMs: mono,
    deadline: t0 + w.budgetMs,
    maxCandidates: w.retrieval.maxCandidates,
    minHitWeight: w.retrieval.minHitWeight,
    ...(input.discord !== undefined ? { discord: input.discord } : {}),
  });
  const decisions = (input.decider ?? decide)(state, w);
  const ranked = decisions.ranking.flatMap((i) => {
    const candidate = state.candidates[i];
    const r = decisions.relevance[i];
    return candidate === undefined || r === undefined ? [] : [{ candidate, expected: r.expected }];
  });
  const elapsedMs = mono() - t0;
  const over = state.budgetExceeded || elapsedMs > w.budgetMs;
  const level = over ? "budget" : gateOf(decisions, w, state.candidates.length);
  let shown: SystemOneRun["shown"] = [];
  if (level === "high") {
    shown = ranked
      .slice(0, w.gate.highMax)
      .filter((x, i) => i < w.gate.highMin || x.expected >= w.gate.minExpected);
  } else if (level === "mid") {
    shown = ranked.slice(0, w.gate.midMax);
  }
  const items: BlockItem[] = shown.map((x) => ({
    candidate: x.candidate,
    readPath:
      x.candidate.repo !== null && x.candidate.path !== null && input.dirOf !== undefined
        ? joinReadPath(input.dirOf(x.candidate.repo), x.candidate.path)
        : null,
  }));
  const block =
    (level === "high" || level === "mid") && items.length > 0
      ? buildCandidateBlock(level, items)
      : null;
  return {
    state,
    decisions,
    gate: level,
    ranked,
    shown,
    block,
    elapsedMs: Math.round(mono() - t0),
  };
}

function joinReadPath(dir: string | null, path: string): string | null {
  if (dir === null) return null;
  return dir === "" ? path : `${dir}/${path}`;
}

/** 引用(ResolvedCitation と同形の最小)。 */
export interface CitedRef {
  kind: string;
  repo?: string;
  path?: string;
  url?: string;
}

export interface SystemOnePrepareInput {
  queryId: string;
  question: string;
  /** 今回の /ask で検索するリポ(引用の許可リストと同じ集合)。 */
  synced: readonly SyncedRepo[];
  /** エージェントの cwd(clonesDir)。 */
  cwd: string;
}

/** /ask へのフック(ask.ts が同期後・検索前に呼ぶ)。 */
export interface SystemOneHook {
  readonly mode: Exclude<FastpathMode, "off">;
  /** 候補ブロック(前置き)を返す。前置きしないとき(shadow・low・失敗)は null。throw しない。 */
  prepare(input: SystemOnePrepareInput): Promise<string | null>;
  /** 引用の検証後に呼び、候補が引用されたかを測れるよう記録する。throw しない。 */
  recordCited(queryId: string, cited: readonly CitedRef[]): void;
}

export interface SystemOneDeps {
  mode: Exclude<FastpathMode, "off">;
  weights: SystemOneWeights;
  store?: SystemOneDecisionStore;
  cache?: CatalogCache;
  /** 壁時計 ms(既定 Date.now)。 */
  nowMs?: () => number;
  /** 単調クロック ms(既定 performance.now)。 */
  monotonicMs?: () => number;
  /** ISO 8601 JST(記録の時刻)。 */
  nowIso: () => string;
  discord?: DiscordCandidateSource;
  decider?: SystemOneDecider;
  logWarn?: (data: Record<string, unknown>, msg: string) => void;
}

/** 記録に残す候補の件数。 */
const LOGGED_CANDIDATES = 8;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** ms 以内に解決しなければ undefined(元の Promise は裏で続く)。 */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createSystemOne(deps: SystemOneDeps): SystemOneHook {
  const cache = deps.cache ?? createCatalogCache();
  const nowMs = deps.nowMs ?? Date.now;
  const mono = deps.monotonicMs ?? (() => performance.now());
  const w = deps.weights;

  const record = (
    queryId: string,
    outcome: SystemOneOutcome,
    run: SystemOneRun | null,
    elapsedMs: number,
  ): void => {
    if (deps.store === undefined) return;
    try {
      const d = run?.decisions;
      deps.store.recordSystemOneDecision({
        queryId,
        createdAt: deps.nowIso(),
        mode: deps.mode,
        gate: outcome,
        pAnswerable: d === undefined ? null : round3(d.answerableFromCandidates.p),
        pTimeSensitive: d === undefined ? null : round3(d.timeSensitive.p),
        pNeedsCode: d === undefined ? null : round3(d.needsCode.p),
        primarySource: d?.primarySource.option ?? null,
        primaryDistJson:
          d === undefined
            ? null
            : JSON.stringify(
                Object.fromEntries(
                  Object.entries(d.primarySource.distribution).map(([k, v]) => [k, round3(v)]),
                ),
              ),
        // 位置情報と期待値だけ(質問文・抜粋は残さない・ADR-0041 D6)。
        candidatesJson: JSON.stringify(
          (run?.ranked ?? []).slice(0, LOGGED_CANDIDATES).map((x) => ({
            kind: x.candidate.kind,
            ...(x.candidate.repo !== null ? { repo: x.candidate.repo } : {}),
            ...(x.candidate.path !== null ? { path: x.candidate.path } : {}),
            ...(x.candidate.url !== null ? { url: x.candidate.url } : {}),
            expected: round3(x.expected),
            shown: run?.shown.includes(x) ?? false,
          })),
        ),
        elapsedMs: Math.round(elapsedMs),
        weightsVersion: w.version,
      });
    } catch (err) {
      deps.logWarn?.({ err }, "system-one: 判定の記録に失敗しました(検索は続けます)");
    }
  };

  return {
    mode: deps.mode,
    async prepare(input) {
      const t0 = mono();
      try {
        const refs = input.synced.map((s) => ({
          repo: s.repo,
          absDir: s.absDir,
          sha: s.resolvedCommit,
        }));
        // HEAD が変わったリポだけ作り直す。待ちの上限を超えたら今回は前置き無し(作成は裏で続く)。
        const building = cache.refresh(refs);
        building.catch((err: unknown) =>
          deps.logWarn?.({ err }, "system-one: カタログの作成に失敗しました"),
        );
        const catalog = await within(building, w.buildWaitMs);
        if (catalog === undefined) {
          record(input.queryId, "catalog_wait", null, mono() - t0);
          return null;
        }
        const dirs = new Map(
          input.synced.map((s) => [s.repo, relative(input.cwd, s.absDir).split(sep).join("/")]),
        );
        const run = await runSystemOne({
          question: input.question,
          catalog,
          weights: w,
          nowMs: nowMs(),
          monotonicMs: mono,
          ...(deps.discord !== undefined ? { discord: deps.discord } : {}),
          ...(deps.decider !== undefined ? { decider: deps.decider } : {}),
          dirOf: (repo) => {
            const d = dirs.get(repo);
            // cwd の外(../)に出るなら読むパスは示さない(repo/path だけ)。
            return d === undefined || d.startsWith("..") ? null : d;
          },
        });
        record(input.queryId, run.gate, run, mono() - t0);
        return deps.mode === "on" ? run.block : null;
      } catch (err) {
        deps.logWarn?.({ err }, "system-one: 判定に失敗しました(前置き無しで検索します)");
        record(input.queryId, "error", null, mono() - t0);
        return null;
      }
    },
    recordCited(queryId, cited) {
      if (deps.store === undefined) return;
      try {
        const refs = cited.map((c) =>
          c.kind === "discord"
            ? { kind: c.kind, url: c.url }
            : { kind: c.kind, repo: c.repo, ...(c.path !== undefined ? { path: c.path } : {}) },
        );
        deps.store.setSystemOneCited(queryId, JSON.stringify(refs), deps.nowIso());
      } catch (err) {
        deps.logWarn?.({ err }, "system-one: 引用の記録に失敗しました");
      }
    },
  };
}

/**
 * env の ASK_FASTPATH から bot 用のフックを作る(off なら undefined = 判定層を作らない)。
 * weights.json が壊れていたら warn して undefined(機能 OFF で起動を続ける)。
 */
export function createSystemOneFromMode(
  mode: FastpathMode | undefined,
  deps: Omit<SystemOneDeps, "mode" | "weights"> & { weights?: SystemOneWeights },
): SystemOneHook | undefined {
  if (mode === undefined || mode === "off") return undefined;
  let weights: SystemOneWeights;
  try {
    weights = deps.weights ?? loadDefaultWeights();
  } catch (err) {
    deps.logWarn?.({ err }, "system-one: weights.json が不正なため無効にします(ADR-0041 D1)");
    return undefined;
  }
  return createSystemOne({ ...deps, mode, weights });
}
