/**
 * gap-tracker エントリポイント(design.md §6.5 / C5 / ADR-0014)。
 * bot と同じ VM の systemd timer(平日 10:00 JST)から起動される。env/config をロードし、
 * 実 seam を組み立てて runGapTracker を呼ぶ。実 commit/依頼は GAP_TRACKER_REAL 時のみ(既定 dry-run)。
 */
import { execFile } from "node:child_process";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createSqliteStore } from "@stratum/discord-bot/sqlite-store";
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { createLocalIdCounterStore, validateRepo } from "@stratum/kb-core";
import { createFsConfigReader, loadGapConfig } from "./config.js";
import { isReal, parseEnv } from "./env.js";
import { type GitExec, syncKb } from "./kb-sync.js";
import { createLogger } from "./logger.js";
import { isoWeekKey } from "./question.js";
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

async function main(): Promise<void> {
  const env = parseEnv();
  const secrets = [env.GITHUB_TOKEN, env.GITHUB_APP_PRIVATE_KEY, env.DISCORD_GAP_WEBHOOK].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const logger = createLogger(secrets);
  const real = isReal(env);
  const config = await loadGapConfig(createFsConfigReader(env.CONFIG_DIR));
  const store = createSqliteStore(env.DB_PATH);

  // 週3件/人の予約(§6.5 L501)。real は bot.db の rate_limits を使い、dry-run はローカルで模す
  // (dry-run が本番の週予算を消費しないように)。
  const localCounts = new Map<string, number>();
  const reserveAssignee = (github: string): boolean => {
    const week = isoWeekKey(new Date());
    if (!real) {
      const key = `${github}|${week}`;
      const n = (localCounts.get(key) ?? 0) + 1;
      localCounts.set(key, n);
      return n <= 3;
    }
    return store.hitRateLimit(`assignee:${github}`, "gap_request", week, 3).allowed;
  };

  const githubForDiscord = (discordId: string): string | undefined =>
    config.assignees.find((a) => a.discord === discordId)?.github;

  try {
    const summary = await runGapTracker({
      config,
      store,
      syncKb: () =>
        syncKb(
          {
            dir: config.kb_dir,
            baseBranch: config.base_branch,
            ...(config.kb_url ? { url: config.kb_url } : {}),
          },
          env.CLONES_DIR,
          gitExec,
        ),
      gh: real ? createGhClientFromEnv() : nullGhClient(),
      makeIdStore: (kbRoot) => createLocalIdCounterStore(kbRoot),
      validate: (kbRoot) => validateRepo(kbRoot),
      listQuestionRaws,
      readFile: (p) => fsReadFile(p, "utf8"),
      writeFile: async (p, content) => {
        await mkdir(dirname(p), { recursive: true });
        await fsWriteFile(p, content, "utf8");
      },
      postRequest: async (content) => {
        const res = await fetch(env.DISCORD_GAP_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) {
          logger.warn("依頼の投稿に失敗(リマインドで回収・PR-D3)", { status: res.status });
        }
      },
      reserveAssignee,
      githubForDiscord,
      now: () => new Date(),
      logger,
      real,
    });
    logger.info("gap-tracker 完了", { ...summary });
  } finally {
    store.close();
  }
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("gap-tracker failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
