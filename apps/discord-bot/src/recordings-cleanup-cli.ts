/**
 * VC 録音ディレクトリの保持期限掃除 CLI(ADR-0020 の「音声は保持期間後に削除してよい」の実装)。
 * bot と同じ VM の systemd timer(stratum-recordings-cleanup.timer・毎日 04:30 JST)から起動される。
 * 判定ロジックは recordings-cleanup.ts(純関数)、ここは I/O と env の配線のみ。
 *
 * 既定は dry-run(消す予定と合計サイズをログ)。実削除は RECORDINGS_CLEANUP_REAL=1 のときだけ
 * (gap-tracker / freshness と同じ REAL ゲート流儀)。
 *
 * パス注意: このプロセスは**ホスト**で動くため対象は ~/stratum/recordings(= RECORDINGS_DIR)。
 * bot.db の payload に入る filePath はコンテナ内パス(/recordings/...)なので照合には使わず、
 * meetingId ↔ ディレクトリ名で突き合わせる。rootless docker では uid0 = ホストユーザのため
 * 録音ファイルはホストユーザ所有 = ホストから削除できる(ADR-0016 D2)。
 */
import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createLogger } from "./logger.js";
import { planRecordingsCleanup, type RecordingDirInfo } from "./recordings-cleanup.js";
import { createSqliteStore } from "./sqlite-store.js";
import { VOICE_MEMO_ACTION_TYPE } from "./voice.js";

const envSchema = z.object({
  DB_PATH: z.string().default("./data/bot.db"),
  RECORDINGS_DIR: z.string().default("./recordings"),
  RECORDINGS_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  RECORDINGS_TMP_RETENTION_DAYS: z.coerce.number().int().positive().default(3),
  RECORDINGS_CLEANUP_REAL: z.string().optional(),
});

/** ディレクトリ 1 件のサイズ(bytes)を再帰で合計する(ログ用途なので失敗は 0 扱い)。 */
async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      try {
        total += (await stat(p)).size;
      } catch {
        // 掃除中に消えたファイルは無視(サイズ集計はベストエフォート)。
      }
    }
  }
  return total;
}

async function collectDirs(root: string): Promise<RecordingDirInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const dirs: RecordingDirInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(root, e.name);
    const st = await stat(path);
    let hasTmp = false;
    let tmpMtimeMs: number | undefined;
    try {
      const tmpSt = await stat(join(path, "tmp"));
      hasTmp = tmpSt.isDirectory();
      if (hasTmp) tmpMtimeMs = tmpSt.mtimeMs;
    } catch {
      // tmp/ 無し(finalize 済みで sidecar が作らなかったケース)。
    }
    dirs.push({
      name: e.name,
      mtimeMs: st.mtimeMs,
      hasTmp,
      ...(tmpMtimeMs !== undefined ? { tmpMtimeMs } : {}),
    });
  }
  return dirs;
}

/** pending な voice_memo の meetingId 集合(payload の meetingId を読む)。 */
function pendingMeetingIds(payloads: readonly (string | null)[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of payloads) {
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as { meetingId?: unknown };
      if (typeof parsed.meetingId === "string" && parsed.meetingId.length > 0) {
        ids.add(parsed.meetingId);
      }
    } catch {
      // 壊れた payload は無視(消さない方に倒れないよう、pending 判定に入れないだけ)。
    }
  }
  return ids;
}

function mib(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const logger = createLogger("info");
  const real = env.RECORDINGS_CLEANUP_REAL === "1";
  const root = env.RECORDINGS_DIR;

  const store = createSqliteStore(env.DB_PATH);
  let pending: Set<string>;
  try {
    const actions = store
      .listPendingActions(VOICE_MEMO_ACTION_TYPE)
      .filter((a) => a.state === "pending");
    pending = pendingMeetingIds(actions.map((a) => a.payloadJson));
  } finally {
    store.close();
  }

  const dirs = await collectDirs(root);
  const plan = planRecordingsCleanup({
    dirs,
    pendingMeetingIds: pending,
    now: new Date(),
    retentionDays: env.RECORDINGS_RETENTION_DAYS,
    tmpRetentionDays: env.RECORDINGS_TMP_RETENTION_DAYS,
  });

  let freed = 0;
  for (const name of plan.removeDirs) {
    const path = join(root, name);
    freed += await dirSize(path);
    if (real) await rm(path, { recursive: true, force: true });
  }
  for (const name of plan.removeTmpOnly) {
    const path = join(root, name, "tmp");
    freed += await dirSize(path);
    if (real) await rm(path, { recursive: true, force: true });
  }

  if (plan.keptPending.length > 0) {
    // 一時失敗で滞留している音声(pending のまま消さずに残す)。滞留の可視化。
    logger.warn(
      { meetingIds: plan.keptPending },
      "処理待ち(pending)の録音があるため保持しました。パイプライン失敗が滞留していないか確認してください",
    );
  }
  logger.info(
    {
      real,
      scanned: dirs.length,
      removedDirs: plan.removeDirs.length,
      removedTmp: plan.removeTmpOnly.length,
      keptPending: plan.keptPending.length,
      ignored: plan.ignored.length,
      freedMiB: mib(freed),
      retentionDays: env.RECORDINGS_RETENTION_DAYS,
      tmpRetentionDays: env.RECORDINGS_TMP_RETENTION_DAYS,
    },
    real
      ? "録音ディレクトリを掃除しました"
      : "dry-run: 削除しません(RECORDINGS_CLEANUP_REAL=1 で実削除)",
  );
}

main().catch((err) => {
  createLogger().error({ err }, "recordings-cleanup-cli failed");
  process.exitCode = 1;
});
