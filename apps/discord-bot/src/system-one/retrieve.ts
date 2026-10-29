/**
 * System One の共有状態づくり(ADR-0041 D1):語・時間範囲・質問の手がかりと、カタログから語の一致で選んだ
 * 候補(特徴量つき)をまとめる。判定(decide.ts)はこの状態だけを見る純関数。
 *
 * 候補の選定は**語の一致だけ**(embedding なし・§5.4)。本文の走査はメモリ上のカタログに対する
 * `String.includes` で、時間予算(deadline)を過ぎたら打ち切って budgetExceeded を立てる。
 * Discord の候補は DiscordCandidateSource の口だけを用意する(実装は別 PR・ADR-0041 D9)。
 */
import type { Catalog, CatalogEntry } from "./catalog.js";
import {
  extractTerms,
  normalizeText,
  parseTimeWindow,
  type QueryTerm,
  type QuestionSignals,
  questionSignals,
  type TimeWindow,
} from "./terms.js";

/** 候補の特徴量の名前(すべて 0〜1)。weights.json の relevance.weights のキー。 */
export const CANDIDATE_FEATURES = [
  "title",
  "meta",
  "summary",
  "body",
  "coverage",
  "longest",
  "inWindow",
  "outWindow",
  "recency",
  "stale",
] as const;
export type CandidateFeatureName = (typeof CANDIDATE_FEATURES)[number];
export type CandidateFeatures = Record<CandidateFeatureName, number>;

/** Discord 由来の候補の元データ(DiscordCandidateSource が返す)。 */
export interface DiscordCandidateDoc {
  /** メッセージの permalink(引用にそのまま使える形)。 */
  url: string;
  /** 表示用の短い題(チャンネル名など)。 */
  title: string;
  /** YYYY-MM-DD(JST)。 */
  date: string | null;
  /** 本文(短く切ったもの)。 */
  text: string;
}

/**
 * Discord の候補を返す口(ADR-0041 D9)。**本 PR では実装しない**。実装は質問者の閲覧範囲で絞ること
 * (ADR-0038 D5)。since / until は YYYY-MM-DD(JST)。
 */
export interface DiscordCandidateSource {
  search(
    terms: readonly string[],
    since: string | null,
    until: string | null,
    limit: number,
  ): Promise<DiscordCandidateDoc[]>;
}

/** 候補 1 件(カタログ or Discord)。 */
export interface Candidate {
  kind: "kb" | "minutes" | "discord";
  /** "org/name"(Discord は null)。 */
  repo: string | null;
  /** リポ相対パス(Discord は null)。 */
  path: string | null;
  /** Discord の permalink(カタログは null)。 */
  url: string | null;
  title: string;
  date: string | null;
  features: CandidateFeatures;
  /** 本文中で最も重い一致語の位置(抜粋用。無ければ -1)。 */
  firstHit: number;
  /** 抜粋の元テキスト(NFKC 済み本文)。 */
  body: string;
  /** 一致した語の重みの合計(足切り・並べ替えの前段)。 */
  hitWeight: number;
}

/** 質問全体の特徴量(すべて 0〜1)。 */
export interface QuestionFeatures extends QuestionSignals {
  hasWindow: number;
  /** 語の数(÷10・1 で頭打ち)。 */
  termCount: number;
}

/** 判定の入力(Jev の「共有の状態」)。 */
export interface SystemOneState {
  terms: QueryTerm[];
  window: TimeWindow | null;
  question: QuestionFeatures;
  candidates: Candidate[];
  /** Discord の候補源が使えたか(primarySource の discord の手がかり)。 */
  discordAvailable: boolean;
  /** 時間予算を超えて走査を打ち切ったか(true なら判定は「低」に倒す)。 */
  budgetExceeded: boolean;
}

const DAY_MS = 86_400_000;
/** 鮮度の減衰の時定数(日)。 */
const RECENCY_TAU_DAYS = 180;
const STALE_STATUSES: ReadonlySet<string> = new Set(["stale", "deprecated", "superseded"]);

interface MatchDoc {
  norm: { title: string; meta: string; summary: string; body: string };
  date: string | null;
  status: string | null;
}

/** 1 文書の特徴量(語の一致・時間範囲・鮮度)。一致が無ければ null。 */
export function scoreDoc(
  doc: MatchDoc,
  terms: readonly QueryTerm[],
  window: TimeWindow | null,
  nowMs: number,
): { features: CandidateFeatures; firstHit: number; hitWeight: number } | null {
  let total = 0;
  for (const t of terms) total += t.weight;
  if (total === 0) return null;
  let title = 0;
  let meta = 0;
  let summary = 0;
  let body = 0;
  let any = 0;
  let longest = 0;
  let firstHit = -1;
  let firstHitWeight = -1;
  for (const t of terms) {
    const inTitle = doc.norm.title.includes(t.text);
    const inMeta = doc.norm.meta.includes(t.text);
    const inSummary = doc.norm.summary.includes(t.text);
    const at = doc.norm.body.indexOf(t.text);
    if (inTitle) title += t.weight;
    if (inMeta) meta += t.weight;
    if (inSummary) summary += t.weight;
    if (at >= 0) {
      body += t.weight;
      if (t.weight > firstHitWeight) {
        firstHit = at;
        firstHitWeight = t.weight;
      }
    }
    if (inTitle || inMeta || inSummary || at >= 0) {
      any += t.weight;
      if (t.kind !== "bigram") longest = Math.max(longest, [...t.text].length);
    }
  }
  if (any === 0) return null;
  let inWindow = 0;
  let outWindow = 0;
  if (window !== null && doc.date !== null) {
    if (doc.date >= window.since && doc.date <= window.until) inWindow = 1;
    else outWindow = 1;
  }
  let recency = 0;
  if (doc.date !== null) {
    const t = Date.parse(`${doc.date}T00:00:00+09:00`);
    if (!Number.isNaN(t)) {
      const ageDays = Math.max(0, (nowMs - t) / DAY_MS);
      recency = Math.exp(-ageDays / RECENCY_TAU_DAYS);
    }
  }
  return {
    features: {
      title: title / total,
      meta: meta / total,
      summary: summary / total,
      body: body / total,
      coverage: any / total,
      longest: Math.min(1, longest / 6),
      inWindow,
      outWindow,
      recency,
      stale: doc.status !== null && STALE_STATUSES.has(doc.status) ? 1 : 0,
    },
    firstHit,
    hitWeight: any,
  };
}

export interface BuildStateInput {
  question: string;
  catalog: Catalog;
  nowMs: number;
  /** 単調クロック ms(時間予算の判定)。 */
  monotonicMs: () => number;
  /** この時刻(monotonicMs 基準)を過ぎたら走査を打ち切る。 */
  deadline: number;
  maxCandidates: number;
  minHitWeight: number;
  discord?: DiscordCandidateSource;
}

/** 何件ごとに時間予算を確かめるか。 */
const DEADLINE_CHECK_EVERY = 32;

function candidateOf(e: CatalogEntry, s: NonNullable<ReturnType<typeof scoreDoc>>): Candidate {
  return {
    kind: e.kind,
    repo: e.repo,
    path: e.path,
    url: null,
    title: e.title,
    date: e.date,
    features: s.features,
    firstHit: s.firstHit,
    body: e.body,
    hitWeight: s.hitWeight,
  };
}

/** 質問とカタログから共有の状態を作る。 */
export async function buildState(input: BuildStateInput): Promise<SystemOneState> {
  const { window, stripped } = parseTimeWindow(input.question, input.nowMs);
  const terms = extractTerms(stripped);
  const sig = questionSignals(input.question);
  const question: QuestionFeatures = {
    ...sig,
    hasWindow: window === null ? 0 : 1,
    termCount: Math.min(1, terms.filter((t) => t.kind !== "bigram").length / 10),
  };
  const candidates: Candidate[] = [];
  let budgetExceeded = false;
  if (terms.length > 0) {
    const entries = input.catalog.entries;
    for (let i = 0; i < entries.length; i += 1) {
      if (i % DEADLINE_CHECK_EVERY === 0 && input.monotonicMs() > input.deadline) {
        budgetExceeded = true;
        break;
      }
      const e = entries[i] as CatalogEntry;
      const s = scoreDoc(e, terms, window, input.nowMs);
      if (s === null || s.hitWeight < input.minHitWeight) continue;
      candidates.push(candidateOf(e, s));
    }
  }
  let discordAvailable = false;
  if (input.discord !== undefined && terms.length > 0 && !budgetExceeded) {
    const remaining = input.deadline - input.monotonicMs();
    const docs = await withTimeout(
      input.discord.search(
        terms.map((t) => t.text),
        window?.since ?? null,
        window?.until ?? null,
        20,
      ),
      Math.max(0, remaining),
    ).catch(() => null);
    if (docs !== null) {
      discordAvailable = true;
      for (const d of docs) {
        const text = d.text.normalize("NFKC");
        const s = scoreDoc(
          {
            norm: {
              title: normalizeText(d.title),
              meta: "",
              summary: "",
              body: text.toLowerCase(),
            },
            date: d.date,
            status: null,
          },
          terms,
          window,
          input.nowMs,
        );
        if (s === null || s.hitWeight < input.minHitWeight) continue;
        candidates.push({
          kind: "discord",
          repo: null,
          path: null,
          url: d.url,
          title: d.title,
          date: d.date,
          features: s.features,
          firstHit: s.firstHit,
          body: text,
          hitWeight: s.hitWeight,
        });
      }
    }
  }
  // 足切り(一致の重みの大きい順・同点は日付の新しい順 → パス順で決定的に)。
  candidates.sort(
    (a, b) =>
      b.hitWeight - a.hitWeight ||
      (b.date ?? "").localeCompare(a.date ?? "") ||
      (a.path ?? a.url ?? "").localeCompare(b.path ?? b.url ?? ""),
  );
  return {
    terms,
    window,
    question,
    candidates: candidates.slice(0, input.maxCandidates),
    discordAvailable,
    budgetExceeded,
  };
}

/** ms 以内に解決しなければ reject(Discord 検索の時間予算)。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("system-one: timeout")), ms);
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
