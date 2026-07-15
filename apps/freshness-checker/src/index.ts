/**
 * freshness-checker エントリポイント(design.md §6.7 / C8 / ADR-0019)。
 * bot と同じ VM の systemd timer(平日 11:00 JST)から起動される。env/config をロードし、
 * 実 seam を組み立てて runFreshnessChecker を呼ぶ。実キュー投入 / 実 commit は
 * FRESHNESS_REAL 時のみ(既定 dry-run)。DM 送信と 👍✏️🗑 の応答処理は bot 側(PR-F4)。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createSqliteStore } from "@stratum/discord-bot/sqlite-store";
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { validateRepo } from "@stratum/kb-core";
import { createFsConfigReader, loadFreshnessConfig } from "./config.js";
import { isReal, parseEnv } from "./env.js";
import { type GitExec, syncKb } from "./kb-sync.js";
import { createLogger } from "./logger.js";
import type { KbFile } from "./overdue.js";
import { runFreshnessChecker } from "./run.js";

const execFileAsync = promisify(execFile);
const gitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};

/** dry-run で GitHub 認証が無いときのスタブ(runFreshnessChecker は dry-run では gh を呼ばない)。 */
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

/** knowledge/<domain>/*.md の一覧(_ / . 始まりのディレクトリは対象外)。無ければ []。 */
async function listKnowledgeFiles(kbRoot: string): Promise<KbFile[]> {
  const base = join(kbRoot, "knowledge");
  let domains: Dirent[];
  try {
    domains = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: KbFile[] = [];
  for (const d of domains) {
    if (!d.isDirectory() || d.name.startsWith("_") || d.name.startsWith(".")) continue;
    let names: string[];
    try {
      names = (await readdir(join(base, d.name))).filter((n) => n.endsWith(".md"));
    } catch {
      continue;
    }
    for (const n of names) {
      out.push({
        path: `knowledge/${d.name}/${n}`,
        raw: await fsReadFile(join(base, d.name, n), "utf8"),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const env = parseEnv();
  const secrets = [env.GITHUB_TOKEN, env.GITHUB_APP_PRIVATE_KEY, env.DISCORD_OPS_WEBHOOK].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const logger = createLogger(secrets);
  const real = isReal(env);
  const config = await loadFreshnessConfig(createFsConfigReader(env.CONFIG_DIR));
  const store = createSqliteStore(env.DB_PATH);
  const gh = real ? createGhClientFromEnv() : nullGhClient();

  // 1 人 1 日 N 件の予約(ADR-0019 D2)。real は bot.db の rate_limits を使い、dry-run はローカルで模す
  // (dry-run が本番の日次予算を消費しないように)。
  const localCounts = new Map<string, number>();
  const reserveOwner = (discordId: string, dateKey: string): boolean => {
    if (!real) {
      const key = `${discordId}|${dateKey}`;
      const n = (localCounts.get(key) ?? 0) + 1;
      localCounts.set(key, n);
      return n <= config.daily_limit_per_owner;
    }
    return store.hitRateLimit(
      `user:${discordId}`,
      "freshness",
      dateKey,
      config.daily_limit_per_owner,
    ).allowed;
  };

  const postOps = async (content: string): Promise<void> => {
    if (env.DISCORD_OPS_WEBHOOK === undefined || env.DISCORD_OPS_WEBHOOK.length === 0) {
      logger.warn("ops webhook 未設定のため stale 降格の報告を送信しません");
      return;
    }
    const res = await fetch(env.DISCORD_OPS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) logger.warn("ops への投稿に失敗", { status: res.status });
  };

  try {
    const summary = await runFreshnessChecker({
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
      gh,
      validate: (kbRoot) => validateRepo(kbRoot),
      listKnowledgeFiles,
      readFile: (p) => fsReadFile(p, "utf8"),
      writeFile: async (p, content) => {
        await mkdir(dirname(p), { recursive: true });
        await fsWriteFile(p, content, "utf8");
      },
      postOps,
      reserveOwner,
      makeId: () => randomUUID(),
      now: () => new Date(),
      logger,
      real,
    });
    logger.info("freshness-checker 完了(index)", { ...summary });
  } finally {
    store.close();
  }
}

main().catch((e) => {
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("freshness-checker failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
