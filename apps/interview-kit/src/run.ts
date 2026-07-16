/**
 * interview-kit オーケストレータ(design.md §6.6 ⑤-b)。
 * 冪等チェック(同一対象の open PR)→ 質問リスト生成(deep・agentic read)→
 * `interviews/kits/<person>-<topic>.md` を **PR で提案** → #stratum-ops へ通知。
 * キットはナレッジエントリではない(validateRepo の対象外)ため staging/検証は不要で、
 * PR は gh-client の API だけで作る。実 PR は real フラグ時のみ(既定 dry-run = 質問をログ)。
 * 全副作用は注入 seam(generate/gh/webhook/clock)。ユニットは fake のみ。
 */
import type { GhClient } from "@stratum/gh-client";
import type { Logger } from "./logger.js";
import { buildKitMarkdown, kitPath, type QuestionKit, slugify } from "./questions.js";

export interface RunDeps {
  /** "org/knowledge-base"(PR の作成先)。 */
  kbRepo: string;
  baseBranch: string;
  /** 対象者(GitHub ユーザ名)と トピック(workflow_dispatch inputs)。 */
  person: string;
  topic: string;
  /** 質問リスト生成(実装は questions.ts の generateQuestions)。 */
  generate: (person: string, topic: string) => Promise<QuestionKit>;
  gh: GhClient;
  /** #stratum-ops への通知(実装は Discord webhook。未設定なら no-op)。 */
  postOps: (content: string) => Promise<void>;
  now: () => Date;
  logger: Logger;
  /** true で実 PR 作成。false は質問リストをログするだけ(既定)。 */
  real: boolean;
}

export interface RunResult {
  created: boolean;
  reason?: string;
  prUrl?: string;
  /** キットの KB リポ相対パス。 */
  path: string;
}

export async function runInterviewKit(deps: RunDeps): Promise<RunResult> {
  const { person, topic, logger } = deps;
  const path = kitPath(person, topic);
  const head = `interview-kit/${slugify(person)}-${slugify(topic)}`;

  // 冪等: 同一対象の open PR があれば再生成しない(LLM を呼ぶ前に判定してコストも節約)。
  if (deps.real) {
    const existing = (await deps.gh.listPullRequests(deps.kbRepo, { state: "open" })).find(
      (p) => p.headRef === head,
    );
    if (existing !== undefined) {
      logger.info("同一対象の質問キット PR が既存のため skip(冪等)", { prUrl: existing.url });
      return { created: false, reason: "already-exists", prUrl: existing.url, path };
    }
  }

  const kit = await deps.generate(person, topic);
  const generatedAt = deps.now().toISOString().slice(0, 10);
  const content = buildKitMarkdown(person, topic, kit, generatedAt);

  if (!deps.real) {
    logger.info("dry-run: PR は作成しません(INTERVIEW_REAL 未設定)。生成結果:", {
      path,
      questions: kit.questions.length,
    });
    logger.info(content);
    return { created: false, reason: "dry-run", path };
  }

  const pr = await deps.gh.createPullRequest({
    repo: deps.kbRepo,
    head,
    base: deps.baseBranch,
    title: `docs(interview): ${person} × ${topic} の質問キット(§6.6 ⑤-b)`,
    body: [
      "interview-kit が生成した質問リストです(§6.6 ⑤-b)。聞き手が内容を確認し、",
      "問題なければマージ → 面談を実施 → 文字起こしを `interviews/` に保存してください",
      "(extractor が自動で複数エントリ化します)。",
      "",
      `- 対象者: @${person}`,
      `- トピック: ${topic}`,
      `- 質問数: ${kit.questions.length}`,
    ].join("\n"),
    files: [{ path, content }],
  });
  await deps.postOps(
    [
      `📝 インタビュー質問キットを作成しました: **${person} × ${topic}**(${kit.questions.length} 問)`,
      pr.url,
      "聞き手を決めて 30〜60 分の面談を設定してください(§6.6 ⑤-b)。",
    ].join("\n"),
  );
  logger.info("質問キット PR を作成しました。", { prUrl: pr.url, path });
  return { created: true, prUrl: pr.url, path };
}
