/**
 * questions/open の open スイープ(ADR-0027 D3 / design.md §6.5)。
 * **status: open かつ assignee 未設定**の滞留質問(extractor の機械起票・全員週上限で残った起票)へ
 * 回答依頼を送り、status open→asked + assignee 記入を main へ 1 コミットする(commitFiles・
 * PR を経ない = §6.5 の意図)。これで KP issue #92 の「open 停留が永遠に放置される」問題を解消する。
 *
 * 担当選定は既存の selectAssignee(expertise 優先 + ラウンドロビン + 週3件/人)をそのまま使い、
 * 選べなければ gap.yaml の fallback_assignees から日替わりローテーション(fallback 宛でも週次上限を
 * 尊重)。それも無理なら status: open のまま warn(従来挙動)。
 * 二重依頼防止は「asked になった質問は次回スイープの対象外」で足りる(台帳は持たない)。
 * 全副作用は注入 seam。実 commit/送信は real フラグ時のみ(既定 dry-run)。
 */
import { join } from "node:path";
import type { FileChange, GhClient } from "@stratum/gh-client";
import {
  type ExpertiseMap,
  parseEntry,
  parseExpertiseMap,
  type QuestionLog,
  serializeEntry,
} from "@stratum/kb-core";
import { resolveAskerMention } from "./close.js";
import type { Assignee, GapConfig } from "./config.js";
import { rankByExpertise } from "./expertise.js";
import type { SyncedKb } from "./kb-sync.js";
import type { Logger } from "./logger.js";
import { buildRequestMessage, selectAssignee } from "./question.js";

/**
 * extractor の機械起票を示す asked_by の規約値(ADR-0027 D3)。
 * apps/extractor/src/open-question.ts の EXTRACTOR_ASKED_BY と同じ値(アプリ間の共有定数は
 * 持たない方針のため、双方にコメントで相互参照を残す)。
 */
export const EXTRACTOR_ASKED_BY = "extractor";

/**
 * fallback_assignees の日替わりローテーション(run.ts の rr と同じ日数基準)。
 * 当日の起点が週上限で塞がっていれば翌候補へ順に試す。全員不可なら null。
 */
export function selectFallback(
  fallbacks: readonly Assignee[],
  now: Date,
  tryReserve: (discord: string) => boolean,
): Assignee | null {
  if (fallbacks.length === 0) return null;
  const start = Math.floor(now.getTime() / 86_400_000) % fallbacks.length;
  for (let i = 0; i < fallbacks.length; i += 1) {
    const a = fallbacks[(start + i) % fallbacks.length];
    if (a !== undefined && tryReserve(a.discord)) return a;
  }
  return null;
}

/**
 * スイープの依頼文。機械起票(asked_by: "extractor")は「誰かが探していた」ではなく
 * 議事録由来であることを示す文面に変える。人間起票は §6.5 L502 の既存テンプレを再利用する
 * (asked_by の discord:<id> / GitHub 名はメンションへ解決。不能なら生の値のまま)。
 */
export function buildSweepRequestMessage(
  assignee: Assignee,
  q: Pick<QuestionLog, "id" | "asked_by" | "question">,
  discordForGithub: (github: string) => string | undefined,
): string {
  if (q.asked_by === EXTRACTOR_ASKED_BY) {
    return [
      `<@${assignee.discord}> さん、議事録から未解決の問いとして抽出されました:「${q.question}」`,
      "1〜2 文で教えてもらえますか? このメッセージに**返信**するだけで OK です。",
      `(${q.id})`,
    ].join("\n");
  }
  const asker = resolveAskerMention(q.asked_by, discordForGithub) ?? q.asked_by;
  return buildRequestMessage(assignee, asker, q.question, q.id);
}

export interface SweepDeps {
  config: GapConfig;
  syncKb: () => Promise<SyncedKb>;
  gh: GhClient;
  validate: (kbRoot: string) => Promise<{ ok: boolean; problems: readonly unknown[] }>;
  /**
   * questions/open/*.md の repo 相対パスと raw。実ファイル名は <id>.md(gap-tracker 起票)と
   * <id>-<slug>.md(extractor 起票・ADR-0027 D3)の両形式があるため、パスは列挙結果を保持して
   * その場で更新する(ID からの再構成はしない)。
   */
  listOpenQuestionFiles: (kbRoot: string) => Promise<{ path: string; raw: string }[]>;
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** 依頼の投稿(§6.5 step3。実装は Discord webhook)。 */
  postRequest: (content: string) => Promise<void>;
  /** 週3件/人の予約(§6.5 L501)。fallback 宛でも同じ上限を通す。 */
  reserveAssignee: (discord: string) => boolean;
  /** GitHub 名 → Discord ID(expertise の優先者写像 + asked_by のメンション解決・ADR-0022)。 */
  discordForGithub: (github: string) => string | undefined;
  now: () => Date;
  logger: Logger;
  /** true で実 commit + 実依頼。false は計画ログのみ(既定)。 */
  real: boolean;
}

export interface SweepSummary {
  /** 依頼を送って asked 化した数(dry-run では予定数)。 */
  assigned: number;
  /** fallback_assignees 宛に依頼した数(assigned の内数)。 */
  fallbackAssigned: number;
  /** 担当が決まらず open のまま残した数。 */
  unassigned: number;
  /** parse 不能で読み飛ばした数。 */
  skipped: number;
  dryRun: boolean;
}

export async function runOpenSweep(deps: SweepDeps): Promise<SweepSummary> {
  const { config, logger } = deps;
  const summary: SweepSummary = {
    assigned: 0,
    fallbackAssigned: 0,
    unassigned: 0,
    skipped: 0,
    dryRun: !deps.real,
  };
  const kb = await deps.syncKb();

  // 対象 = status: open かつ assignee 未設定。asked 済みは対象外(= 二重依頼防止)。
  const targets: { path: string; frontmatter: QuestionLog; body: string }[] = [];
  for (const f of await deps.listOpenQuestionFiles(kb.absDir)) {
    let parsed: { frontmatter: QuestionLog; body: string };
    try {
      parsed = parseEntry(f.raw, "question", f.path);
    } catch (e) {
      logger.warn("questions/open のファイルを parse できないためスキップ", {
        path: f.path,
        error: e instanceof Error ? e.message : String(e),
      });
      summary.skipped += 1;
      continue;
    }
    if (parsed.frontmatter.status === "open" && parsed.frontmatter.assignee === undefined) {
      targets.push({ path: f.path, ...parsed });
    }
  }
  if (targets.length === 0) {
    logger.info("open スイープ: 対象の滞留質問はありません。");
    return summary;
  }

  // §4.4 L302: expertise.yaml があれば担当選定に使う(run.ts と同じ流儀。読めなければ RR のみ)。
  let expertise: ExpertiseMap | null = null;
  try {
    expertise = parseExpertiseMap(
      await deps.readFile(join(kb.absDir, "expertise", "expertise.yaml")),
    );
  } catch {
    logger.info("expertise.yaml が読めないためラウンドロビンのみで選定します。");
  }

  const files: FileChange[] = [];
  const requests: string[] = [];
  const ids: string[] = [];
  // ラウンドロビン起点は日替わり(run.ts の rr と同じ基準)。
  let rr = Math.floor(deps.now().getTime() / 86_400_000) % Math.max(1, config.assignees.length);

  for (const t of targets) {
    const q = t.frontmatter;
    const preferred =
      expertise === null
        ? []
        : rankByExpertise(q.question, expertise)
            .map((gh) => deps.discordForGithub(gh))
            .filter((d): d is string => d !== undefined);
    let assignee = selectAssignee(config.assignees, rr, deps.reserveAssignee, preferred);
    rr += 1;
    let viaFallback = false;
    if (assignee === null) {
      assignee = selectFallback(config.fallback_assignees, deps.now(), deps.reserveAssignee);
      viaFallback = assignee !== null;
    }
    if (assignee === null) {
      // fallback も空(または全員週上限)。従来どおり open のまま残す(次回スイープが再挑戦)。
      logger.warn("担当を解決できないため open のまま残します", { questionId: q.id });
      summary.unassigned += 1;
      continue;
    }
    // 記録値は buildQuestion と同じ規約: GitHub 名が引ければ github、無ければ discord:<id>(ADR-0022)。
    const updated: QuestionLog = {
      ...q,
      status: "asked",
      assignee: assignee.github ?? `discord:${assignee.discord}`,
    };
    const content = serializeEntry({ frontmatter: updated, body: t.body });
    await deps.writeFile(join(kb.absDir, t.path), content); // validateRepo がディスクを読む
    files.push({ path: t.path, content });
    requests.push(buildSweepRequestMessage(assignee, q, deps.discordForGithub));
    ids.push(q.id);
    if (viaFallback) summary.fallbackAssigned += 1;
  }

  if (files.length === 0) {
    logger.info("open スイープ: 担当を割り当てられた質問はありません。", {
      unassigned: summary.unassigned,
    });
    return summary;
  }

  const report = await deps.validate(kb.absDir);
  if (!report.ok) {
    logger.error("validateRepo が失敗。open スイープを commit しません(ADR-0004 D2)。", {
      problems: report.problems.length,
    });
    return { ...summary, assigned: 0, fallbackAssigned: 0 };
  }

  summary.assigned = ids.length;
  if (!deps.real) {
    logger.info("dry-run: commit も依頼送信もしません(GAP_TRACKER_REAL 未設定)。", {
      questions: ids,
      requests: requests.length,
      fallbackAssigned: summary.fallbackAssigned,
    });
    return summary;
  }

  await deps.gh.commitFiles({
    repo: config.kb_repo,
    branch: config.base_branch,
    message: `chore(gap): assign ${ids.length} open question(s) ${ids.join(", ")}`,
    files,
  });
  for (const content of requests) {
    await deps.postRequest(content);
  }
  logger.info("open スイープ: 依頼を送信し asked 化しました。", {
    assigned: summary.assigned,
    fallbackAssigned: summary.fallbackAssigned,
    unassigned: summary.unassigned,
  });
  return summary;
}
