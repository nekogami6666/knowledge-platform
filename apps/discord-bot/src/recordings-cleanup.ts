/**
 * VC 録音ディレクトリの保持期限掃除(ADR-0020「音声は保持期間後に削除してよい」の実装)。
 * 純関数コア: ディレクトリ一覧 + pending の meetingId 集合 + 現在時刻から「消す対象」を決める。
 * I/O(readdir / stat / rm)は CLI 側(recordings-cleanup-cli.ts)が注入する。
 *
 * 掃除が必要な理由: sidecar は finalize 後も参加者ごとの生 PCM(tmp/・約 11.5MB/分/人)と
 * recording.m4a を残す。recorder 再起動で finalize されなかった孤児も溜まる。
 *
 * 安全条件(消してはいけないもの):
 * - ディレクトリ名が `vm-<epochMillis>-<channelId>` 以外(想定外は触らない = ホワイトリスト方式)
 * - まだパイプライン処理待ち(pending_actions の voice_memo)の meetingId — 年齢に関わらず残す
 * - interview セッション(armed / recording / pending)のチャンク meetingId(ADR-0028 D2。
 *   STT 前の音声を retention で失わない)
 * - 年齢が閾値未満のもの。録音中のセッションは DB・recorder API から特定できないため、
 *   閾値は max_recording_minutes(既定 15 分)+ finalize ポーリング上限を大きく上回る「日」単位にする
 */

/** 掃除対象ディレクトリ 1 件の入力(CLI が readdir + stat で組み立てる)。 */
export interface RecordingDirInfo {
  /** ディレクトリ名(= meetingId)。例 `vm-1785076449618-1530111568547942440`。 */
  name: string;
  /** ディレクトリの mtime(epoch ms)。 */
  mtimeMs: number;
  /** 直下に tmp/(生 PCM)があるか。 */
  hasTmp: boolean;
  /** tmp/ の mtime(epoch ms)。hasTmp が false なら undefined。 */
  tmpMtimeMs?: number;
}

export interface CleanupPlanInput {
  dirs: readonly RecordingDirInfo[];
  /** パイプライン処理待ちの meetingId(pending_actions の voice_memo payload 由来)。 */
  pendingMeetingIds: ReadonlySet<string>;
  now: Date;
  /** ディレクトリ全体を消すまでの日数。 */
  retentionDays: number;
  /** tmp/(生 PCM)だけを先に消すまでの日数。retentionDays 以下であること。 */
  tmpRetentionDays: number;
}

export interface CleanupPlan {
  /** ディレクトリごと削除する meetingId。 */
  removeDirs: string[];
  /** tmp/ のみ削除する meetingId(ディレクトリ本体はまだ保持)。 */
  removeTmpOnly: string[];
  /** pending のため年齢を無視して残したもの(滞留の可視化に使う)。 */
  keptPending: string[];
  /** 名前が想定形でないため触らなかったエントリ。 */
  ignored: string[];
}

/**
 * interview セッション行(pending_actions の interview_session)から保護すべき meetingId を集める
 * (ADR-0028 D2: state が done / cancelled 以外 = まだ STT・PR 化されうる音声は消さない)。
 * payload はスキーマ検証せず lenient に読む — 契約が育っても保護が外れない方に倒す
 * (CLI の pendingMeetingIds と同方針)。壊れた JSON は無視(保護に入れないだけ)。
 */
export function interviewProtectedMeetingIds(
  rows: readonly { state: string; payloadJson: string | null }[],
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.state === "done" || row.state === "cancelled") continue;
    if (row.payloadJson === null) continue;
    try {
      const parsed = JSON.parse(row.payloadJson) as {
        chunks?: unknown;
        currentChunk?: unknown;
      };
      if (Array.isArray(parsed.chunks)) {
        for (const chunk of parsed.chunks) {
          const meetingId = (chunk as { meetingId?: unknown }).meetingId;
          if (typeof meetingId === "string" && meetingId.length > 0) ids.add(meetingId);
        }
      }
      const current = (parsed.currentChunk as { meetingId?: unknown } | null | undefined)
        ?.meetingId;
      if (typeof current === "string" && current.length > 0) ids.add(current);
    } catch {
      // 壊れた payload は無視(保護集合に入れないだけ。削除側の判定は年齢が守る)。
    }
  }
  return ids;
}

/** `vm-<epochMillis>-<channelId>`。この形以外は掃除対象にしない。 */
const DIR_NAME_RE = /^vm-(\d+)-\d+$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 年齢の基準時刻。ディレクトリ名の epoch(録音開始)と mtime(最終書き込み)のうち
 * **新しい方**を採る(finalize が遅れたケースで「まだ書き込みがあった」側を尊重する)。
 */
function lastActivityMs(dir: RecordingDirInfo, startedAtMs: number): number {
  return Math.max(startedAtMs, dir.mtimeMs);
}

/** 保持期限を過ぎた録音ディレクトリの削除計画を立てる(純関数)。 */
export function planRecordingsCleanup(input: CleanupPlanInput): CleanupPlan {
  const plan: CleanupPlan = { removeDirs: [], removeTmpOnly: [], keptPending: [], ignored: [] };
  const nowMs = input.now.getTime();
  const dirCutoff = nowMs - input.retentionDays * DAY_MS;
  const tmpCutoff = nowMs - input.tmpRetentionDays * DAY_MS;

  for (const dir of input.dirs) {
    const m = DIR_NAME_RE.exec(dir.name);
    if (m === null) {
      plan.ignored.push(dir.name);
      continue;
    }
    // pending は年齢に関わらず残す(一時失敗で無期限に滞留しうるため、消すと音声を失う)。
    if (input.pendingMeetingIds.has(dir.name)) {
      plan.keptPending.push(dir.name);
      continue;
    }
    const startedAtMs = Number(m[1]);
    const activityMs = lastActivityMs(dir, startedAtMs);
    if (activityMs < dirCutoff) {
      plan.removeDirs.push(dir.name);
      continue;
    }
    // ディレクトリはまだ残すが、容量を食う生 PCM は先に落とす。
    if (dir.hasTmp && (dir.tmpMtimeMs ?? activityMs) < tmpCutoff) {
      plan.removeTmpOnly.push(dir.name);
    }
  }
  return plan;
}
