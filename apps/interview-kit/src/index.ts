/**
 * interview-kit エントリポイント(design.md §6.6 ⑤-b / C7)。
 * GitHub Actions の workflow_dispatch(person / topic)から起動される。env をロードし、
 * 実 seam を組み立てて runInterviewKit を呼ぶ。実 PR は INTERVIEW_REAL 時のみ(既定 dry-run)。
 */
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { isReal, parseEnv, timeoutMs } from "./env.js";
import { createLogger } from "./logger.js";
import { generateQuestions } from "./questions.js";
import { runInterviewKit } from "./run.js";

/** dry-run で GitHub 認証が無いときのスタブ(runInterviewKit は dry-run では gh を呼ばない)。 */
function nullGhClient(): GhClient {
  const fail = (): never => {
    throw new Error("GitHub 認証が未設定です(dry-run 中は gh を使いません)");
  };
  return {
    createPullRequest: async () => fail(),
    listPullRequests: async () => fail(),
    mergePullRequest: async () => fail(),
    getPullRequest: async () => fail(),
    commitFiles: async () => fail(),
    getFileContents: async () => fail(),
    listMergedPullRequests: async () => fail(),
    listPullRequestComments: async () => fail(),
    listPullRequestFiles: async () => fail(),
    listCommits: async () => fail(),
  };
}

async function main(): Promise<void> {
  const env = parseEnv();
  const secrets = [
    env.ANTHROPIC_AWS_API_KEY,
    env.GITHUB_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.DISCORD_OPS_WEBHOOK,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger(secrets);
  const real = isReal(env);
  const gh = real ? createGhClientFromEnv() : nullGhClient();
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);

  const postOps = async (content: string): Promise<void> => {
    if (env.DISCORD_OPS_WEBHOOK === undefined || env.DISCORD_OPS_WEBHOOK.length === 0) {
      logger.warn("ops webhook 未設定のため通知しません");
      return;
    }
    const res = await fetch(env.DISCORD_OPS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) logger.warn("ops への投稿に失敗", { status: res.status });
  };

  const result = await runInterviewKit({
    kbRepo: env.INTERVIEW_KB_REPO,
    baseBranch: "main",
    person: env.INTERVIEW_PERSON,
    topic: env.INTERVIEW_TOPIC,
    generate: async (person, topic) =>
      (
        await generateQuestions(person, topic, {
          promptStore,
          cwd: env.KB_ROOT,
          usage: nullUsageRecorder,
          timeoutMs: timeoutMs(env),
        })
      ).value,
    gh,
    postOps,
    now: () => new Date(),
    logger,
    real,
  });
  logger.info("interview-kit 完了", { ...result });
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("interview-kit failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
