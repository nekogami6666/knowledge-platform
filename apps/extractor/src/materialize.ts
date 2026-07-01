/**
 * 抽出候補 + 突合判定 → 確定 knowledge-base 変更(design.md §6.3 step3-4)。
 * kb-core 経由のみで entry を組み立て(serializeEntry)、gh-client の FileChange[] にして返す。
 * 実際のディスク書き込み / PR 作成は F1c(オーケストレータ)が行う。ここは純関数的
 * (idStore / readFile / now を注入)でユニットテスト可能。
 *
 * - new        : allocateId して新規エントリ(learning→knowledge/<domain>/, decision→decisions/<year>/)。
 * - duplicate  : 既存エントリを読み、meeting 出典を追記して再シリアライズ(採番なし・§6.3(a))。
 * - contradiction: 既存を status:"superseded" にし、新規(learning は supersedes 付き。DecisionRecord は
 *                  supersedes フィールドが無いため status のみ=D8)を作る。
 * open_question は materialize しない(D7・呼び出し側で除外)。
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "@stratum/gh-client";
import {
  allocateId,
  type DecisionRecord,
  type DocKind,
  type IdCounterStore,
  type KnowledgeEntry,
  parseEntry,
  type Source,
  serializeEntry,
} from "@stratum/kb-core";
import type { DecisionCandidate, LearningCandidate } from "./candidate.js";
import { slugify } from "./slug.js";
import type { Verdict } from "./verdict.js";

/** materialize 対象の候補(open_question は D7 で除外)。 */
export type MaterializableCandidate = DecisionCandidate | LearningCandidate;

export interface MaterializeInput {
  /** KB clone の絶対パス(targetPath の解決 + fs 読み取り用)。 */
  kbRoot: string;
  /** 出典に付ける議事録リポ / パス / commit SHA。 */
  minutesRepo: string;
  minutesPath: string;
  minutesRef: string;
  /** 議事録参加者(owner / deciders のフォールバック)。 */
  fallbackPeople: readonly string[];
  candidate: MaterializableCandidate;
  verdict: Verdict;
}

export interface MaterializeDeps {
  /** ID 採番ストア(F1c は createLocalIdCounterStore(kbRoot)、テストは in-memory)。 */
  idStore: IdCounterStore;
  /** 現在時刻(created/last_verified/採番年。既定 実時刻)。 */
  now?: () => Date;
  /** 既存エントリの読み取り(duplicate/contradiction。既定 node:fs)。 */
  readFile?: (absPath: string) => Promise<string>;
}

export type MaterializeAction = "new" | "append" | "supersede" | "skip";

export interface MaterializedChange {
  /** PR に含めるファイル変更(repo 相対パス + 全文)。 */
  files: FileChange[];
  action: MaterializeAction;
  /** new/supersede の新 id、append の対象 id。skip は空文字。 */
  id: string;
  reason?: string;
}

/** JST(+09:00)の YYYY-MM-DD。kb-core の採番年基準に合わせる。 */
function isoDateJst(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function docKindFromId(id: string): DocKind {
  if (id.startsWith("kb-")) return "knowledge";
  if (id.startsWith("dr-")) return "decision";
  if (id.startsWith("q-")) return "question";
  throw new Error(`id から docKind を判定できません: ${id}`);
}

/** "kb-2026-0001" → "2026"。 */
function yearOf(id: string, fallback: Date): string {
  const m = /^[a-z]+-(\d{4})-/.exec(id);
  return m?.[1] ?? isoDateJst(fallback).slice(0, 4);
}

/** 議事録出典(meeting kind に限定した Source。repo/path を型安全に参照するため Extract で narrow)。 */
type MeetingSource = Extract<Source, { kind: "meeting" }>;

function meetingSource(input: MaterializeInput): MeetingSource {
  const base: MeetingSource = {
    kind: "meeting",
    repo: input.minutesRepo,
    path: input.minutesPath,
    ref: input.minutesRef,
  };
  return input.candidate.lines ? { ...base, lines: input.candidate.lines } : base;
}

function slugFor(c: MaterializableCandidate): string {
  return c.slug ?? slugify(c.title);
}

function decisionBody(c: DecisionCandidate): string {
  const parts = [`## 決定内容\n${c.decision}`];
  if (c.rationale) parts.push(`## 理由\n${c.rationale}`);
  if (c.rejectedAlternatives) parts.push(`## 検討した代替案と却下理由\n${c.rejectedAlternatives}`);
  return `\n${parts.join("\n\n")}\n`;
}

function learningBody(c: LearningCandidate): string {
  return `\n## 概要\n${c.body}\n`;
}

/** 新規エントリを1つ作る。supersedes を渡すと learning(KnowledgeEntry)に付与する(DR には無い=D8)。 */
async function createNew(
  input: MaterializeInput,
  deps: MaterializeDeps,
  now: () => Date,
  supersedes?: string,
): Promise<MaterializedChange> {
  const c = input.candidate;
  const today = isoDateJst(now());
  const source = meetingSource(input);

  if (c.kind === "decision") {
    const deciders = c.deciders.length > 0 ? [...c.deciders] : [...input.fallbackPeople];
    if (deciders.length === 0) {
      return {
        files: [],
        action: "skip",
        id: "",
        reason: "決定者を特定できないため skip(§6.3 / D5)",
      };
    }
    const id = await allocateId("dr", deps.idStore, { now: now() });
    const entry: DecisionRecord = {
      id,
      title: c.title,
      date: today,
      status: "accepted",
      deciders,
      sources: [source],
      tags: [],
    };
    const path = `decisions/${yearOf(id, now())}/${id}-${slugFor(c)}.md`;
    return {
      files: [{ path, content: serializeEntry({ frontmatter: entry, body: decisionBody(c) }) }],
      action: "new",
      id,
    };
  }

  const id = await allocateId("kb", deps.idStore, { now: now() });
  const owner = c.people[0] ?? input.fallbackPeople[0] ?? "unassigned";
  // review_interval_days は省略 → serializeEntry/parse で type 別デフォルトが適用される。
  const entry: Omit<KnowledgeEntry, "review_interval_days"> = {
    id,
    title: c.title,
    type: c.entryType,
    domain: c.domain,
    tags: [...c.tags],
    sources: [source],
    people: [...c.people],
    confidence: c.confidence,
    status: "active",
    created: today,
    last_verified: today,
    owner,
    ...(supersedes ? { supersedes } : {}),
  };
  const path = `knowledge/${c.domain}/${id}-${slugFor(c)}.md`;
  return {
    files: [{ path, content: serializeEntry({ frontmatter: entry, body: learningBody(c) }) }],
    action: "new",
    id,
  };
}

/** 既存エントリを読み、meeting 出典を追記して再シリアライズ(重複出典は足さない)。 */
async function appendSource(
  input: MaterializeInput,
  readFile: (p: string) => Promise<string>,
): Promise<MaterializedChange> {
  const { targetPath, targetId } = input.verdict;
  if (targetPath === undefined || targetId === undefined) {
    return { files: [], action: "skip", id: "", reason: "duplicate だが対象未指定のため skip" };
  }
  const docKind = docKindFromId(targetId);
  if (docKind === "question") {
    return { files: [], action: "skip", id: "", reason: "question は突合対象外" };
  }
  const raw = await readFile(join(input.kbRoot, targetPath));
  const parsed = parseEntry(raw, docKind, targetPath);
  const fm = parsed.frontmatter as unknown as { sources: Source[] } & Record<string, unknown>;
  const src = meetingSource(input);
  const already = fm.sources.some(
    (s) => s.kind === "meeting" && s.repo === src.repo && s.path === src.path,
  );
  const sources = already ? fm.sources : [...fm.sources, src];
  const content = serializeEntry({ frontmatter: { ...fm, sources }, body: parsed.body });
  return { files: [{ path: targetPath, content }], action: "append", id: targetId };
}

/** 既存を status:"superseded" にし、新規(learning は supersedes 付き)を作る。 */
async function supersedeAndCreate(
  input: MaterializeInput,
  deps: MaterializeDeps,
  now: () => Date,
  readFile: (p: string) => Promise<string>,
): Promise<MaterializedChange> {
  const { targetPath, targetId } = input.verdict;
  if (targetPath === undefined || targetId === undefined) {
    return createNew(input, deps, now); // 対象不明なら単に新規
  }
  const created = await createNew(input, deps, now, targetId);
  if (created.action === "skip") return created; // 置き換え先を作れないなら supersede しない

  const docKind = docKindFromId(targetId);
  const raw = await readFile(join(input.kbRoot, targetPath));
  const parsed = parseEntry(raw, docKind, targetPath);
  const oldContent = serializeEntry({
    frontmatter: { ...(parsed.frontmatter as Record<string, unknown>), status: "superseded" },
    body: parsed.body,
  });
  return {
    files: [{ path: targetPath, content: oldContent }, ...created.files],
    action: "supersede",
    id: created.id,
  };
}

/** 候補 + verdict を確定変更(FileChange[])に materialize する。 */
export async function materializeOne(
  input: MaterializeInput,
  deps: MaterializeDeps,
): Promise<MaterializedChange> {
  const now = deps.now ?? (() => new Date());
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  switch (input.verdict.classification) {
    case "duplicate":
      return appendSource(input, readFile);
    case "contradiction":
      return supersedeAndCreate(input, deps, now, readFile);
    default:
      return createNew(input, deps, now);
  }
}
