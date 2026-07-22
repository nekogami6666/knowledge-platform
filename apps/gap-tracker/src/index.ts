/**
 * gap-tracker エントリポイント(design.md §6.5 / C5 / ADR-0014)。
 * bot と同じ VM の systemd timer(平日 10:00 JST)から起動される。env/config をロードし、
 * 実 seam を組み立てて runGapTracker を呼ぶ。実 commit/依頼は GAP_TRACKER_REAL 時のみ(既定 dry-run)。
 */
import { execFile } from "node:child_process";
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createSqliteStore } from "@stratum/discord-bot/sqlite-store";
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import {
  createLocalIdCounterStore,
  parseEntry,
  type QuestionLog,
  validateRepo,
} from "@stratum/kb-core";
import { createFsPromptStore, nullUsageRecorder } from "@stratum/llm";
import { runFlywheelClose } from "./close.js";
import { createFsConfigReader, loadGapConfig } from "./config.js";
import { draftEntry } from "./draft.js";
import { isReal, parseEnv } from "./env.js";
import { runAnswerIngestion } from "./ingest.js";
import { type GitExec, syncKb } from "./kb-sync.js";
import { createLogger } from "./logger.js";
import { loadMembers } from "./members.js";
import {
  assigneePool,
  isoWeekKey,
  resolveDiscordForGithub,
  resolveGithubForDiscord,
} from "./question.js";
import { runGapTracker } from "./run.js";

const execFileAsync = promisify(execFile);
const gitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};

/** dry-run で GitHub 認証が無いときのスタブ(runGapTracker は dry-run では gh を呼ばない)。 */
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

/** questions/open + answered の raw 一覧(冪等スキャン用)。ディレクトリが無ければ []。 */
async function listQuestionRaws(kbRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ["open", "answered"]) {
    const dir = join(kbRoot, "questions", sub);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
    } catch {
      continue;
    }
    for (const n of names) out.push(await fsReadFile(join(dir, n), "utf8"));
  }
  return out;
}

/** questions/open の全 QuestionLog(リマインド走査用)。壊れた/別種ファイルはスキップ(best-effort)。 */
async function listOpenQuestions(kbRoot: string): Promise<QuestionLog[]> {
  const dir = join(kbRoot, "questions", "open");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: QuestionLog[] = [];
  for (const n of names) {
    try {
      const raw = await fsReadFile(join(dir, n), "utf8");
      out.push(parseEntry(raw, "question", `questions/open/${n}`).frontmatter);
    } catch {
      // 壊れた行や別種のファイルは無視(リマインドは best-effort)。
    }
  }
  return out;
}

async function main(): Promise<void> {
  const env = parseEnv();
  const secrets = [
    env.GITHUB_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.DISCORD_GAP_WEBHOOK,
    env.DISCORD_OPS_WEBHOOK,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger(secrets);
  const real = isReal(env);
  const config = await loadGapConfig(createFsConfigReader(env.CONFIG_DIR));
  const store = createSqliteStore(env.DB_PATH);
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);
  const gh = real ? createGhClientFromEnv() : nullGhClient();

  // 依頼(step1-3)とナレッジ化(step4-5)で共有する副作用 seam。
  const syncKbThunk = () =>
    syncKb(
      {
        dir: config.kb_dir,
        baseBranch: config.base_branch,
        ...(config.kb_url ? { url: config.kb_url } : {}),
      },
      env.CLONES_DIR,
      gitExec,
    );
  const readFile = (p: string) => fsReadFile(p, "utf8");
  const writeFile = async (p: string, content: string): Promise<void> => {
    await mkdir(dirname(p), { recursive: true });
    await fsWriteFile(p, content, "utf8");
  };
  const readQuestionRaw = async (kbRoot: string, questionId: string): Promise<string | null> => {
    try {
      return await fsReadFile(join(kbRoot, "questions", "open", `${questionId}.md`), "utf8");
    } catch {
      return null;
    }
  };
  const postWebhook = async (
    url: string | undefined,
    content: string,
    label: string,
  ): Promise<void> => {
    if (url === undefined || url.length === 0) {
      logger.warn(`${label} の webhook 未設定のため送信しません`);
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) logger.warn(`${label} の投稿に失敗`, { status: res.status });
  };

  // 週3件/人の予約(§6.5 L501)。real は bot.db の rate_limits を使い、dry-run はローカルで模す
  // (dry-run が本番の週予算を消費しないように)。
  const localCounts = new Map<string, number>();
  const reserveAssignee = (discord: string): boolean => {
    const week = isoWeekKey(new Date());
    if (!real) {
      const key = `${discord}|${week}`;
      const n = (localCounts.get(key) ?? 0) + 1;
      localCounts.set(key, n);
      return n <= 3;
    }
    // subject は discord 主キー(ADR-0022)。汎用 rate_limits テーブルなのでスキーマ変更不要。
    return store.hitRateLimit(`assignee:${discord}`, "gap_request", week, 3).allowed;
  };

  // 質問者・回答者の discord↔github 解決は KB `_meta/members.yaml`(唯一の正・ADR-0017 D3)を
  // 優先する。members は KB clone 内にあるため先に一度同期して読む(各フェーズの再同期は冪等)。
  // sync 失敗は握りつぶさない(親リポガード等の fail-loud を members 読み失敗に誤誘導しない)。
  const kb = await syncKbThunk();
  const members = await loadMembers(readFile, kb.absDir, logger);
  // ADR-0022: assignees 空なら members.yaml 全員を回答者プールにする(「皆で OK」)。
  const assignees = assigneePool(config.assignees, members);
  if (config.assignees.length === 0) {
    logger.info("gap.yaml の assignees が空のため members.yaml 全員を回答者プールにします。", {
      count: assignees.length,
    });
  }
  const githubForDiscord = (discordId: string): string | undefined =>
    resolveGithubForDiscord(members, assignees, discordId);
  const discordForGithub = (github: string): string | undefined =>
    resolveDiscordForGithub(members, assignees, github);

  try {
    // step1-3: 未回答 → questions/open へ commit + 回答者へ依頼(PR-D1)。
    const summary = await runGapTracker({
      config: { ...config, assignees },
      store,
      syncKb: syncKbThunk,
      gh,
      makeIdStore: (kbRoot) => createLocalIdCounterStore(kbRoot),
      validate: (kbRoot) => validateRepo(kbRoot),
      listQuestionRaws,
      readFile,
      writeFile,
      postRequest: (content) => postWebhook(env.DISCORD_GAP_WEBHOOK, content, "依頼"),
      reserveAssignee,
      githubForDiscord,
      discordForGithub,
      now: () => new Date(),
      logger,
      real,
    });
    logger.info("gap-tracker(依頼)完了", { ...summary });

    // step4-5: 捕捉した回答(gap_answer)→ ナレッジ化 PR + #stratum-ops 通知(PR-D3a)。
    const ingestSummary = await runAnswerIngestion({
      config,
      store,
      syncKb: syncKbThunk,
      gh,
      makeIdStore: (kbRoot) => createLocalIdCounterStore(kbRoot),
      validate: (kbRoot) => validateRepo(kbRoot),
      readQuestionRaw,
      readFile,
      writeFile,
      listDomains: async (kbRoot) => {
        try {
          const entries = await readdir(join(kbRoot, "knowledge"), { withFileTypes: true });
          return entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
            .map((e) => e.name);
        } catch {
          return [];
        }
      },
      draft: async (input) =>
        (await draftEntry(input, { promptStore, usage: nullUsageRecorder })).value,
      postOps: (content) => postWebhook(env.DISCORD_OPS_WEBHOOK, content, "ナレッジ化 PR 通知"),
      githubForDiscord,
      now: () => new Date(),
      logger,
      real,
    });
    logger.info("gap-tracker(回答取り込み)完了", { ...ingestSummary });

    // step5 後半: マージ済み → answered 移動 + 質問者通知、7 日リマインド / 14 日 wontfix(PR-D3b)。
    const closeSummary = await runFlywheelClose({
      config,
      store,
      syncKb: syncKbThunk,
      gh,
      validate: (kbRoot) => validateRepo(kbRoot),
      readQuestionRaw,
      listOpenQuestions,
      writeFile,
      removeFile: (p) => rm(p, { force: true }),
      discordForGithub,
      postGap: (content) => postWebhook(env.DISCORD_GAP_WEBHOOK, content, "通知/リマインド"),
      postOps: (content) => postWebhook(env.DISCORD_OPS_WEBHOOK, content, "wontfix レポート"),
      now: () => new Date(),
      logger,
      real,
    });
    logger.info("gap-tracker(フライホイール後半)完了", { ...closeSummary });
  } finally {
    store.close();
  }
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("gap-tracker failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
