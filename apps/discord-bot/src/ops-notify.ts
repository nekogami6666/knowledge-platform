/**
 * #stratum-ops への運用通知(VM タイマーの失敗・復旧・本番更新)と、その出来事の記録。
 *
 * - 失敗: 直近ログのエラー行から原因を分類し、まず試すことを添えて通知する。失敗中の印を残す。
 * - 復旧: 失敗中の印がある unit が成功したら「復旧しました」と通知し、印を消す。
 * - 本番更新: update.sh が反映した commit の件名(fix / feat / perf)を通知する。
 * - 記録: 出来事を JSONL に 1 行ずつ追記し、週次レポート(stats.ts)が直近 7 日を集計する。
 *
 * 秘密は出さない(§9.1): 通知に載せるログ行は describeError で資格情報を除いたもの(各 app 側)に加え、
 * ここでも maskSecrets を通す。webhook URL はログに出さない。
 */
import { maskSecrets } from "@stratum/shared";

export type FailureCategory =
  | "auth"
  | "rate_limit"
  | "transient"
  | "timeout"
  | "config"
  | "build"
  | "unknown";

export interface FailureClass {
  category: FailureCategory;
  /** 利用者向けの分類名。 */
  label: string;
  /** まず試すこと(unit 名を埋め込む)。 */
  hint: string;
}

interface Rule {
  category: FailureCategory;
  label: string;
  pattern: RegExp;
  hint: (unit: string) => string;
}

// 上から順に判定する(例: 認証エラーの 401 を一時障害より先に拾う)。
const RULES: readonly Rule[] = [
  {
    category: "auth",
    label: "認証・権限",
    pattern: /HTTP 40[13]\b|Bad credentials|\bAUTH\b|Authentication failed|permission denied/i,
    hint: () =>
      "トークン(GIT_CLONE_TOKEN・GitHub App・Claude on AWS のキー)の期限と権限を確認し、stratum.env を更新してください。",
  },
  {
    category: "rate_limit",
    label: "レート制限",
    pattern: /HTTP 429\b|rate limit|RATE_LIMITED|secondary rate/i,
    hint: () =>
      "時間をおけば次回の定期実行で回復します。頻発するなら実行間隔や件数の上限を下げます。",
  },
  {
    category: "build",
    label: "ビルド・デプロイ",
    pattern: /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|is not a function/,
    hint: () =>
      "VM で ./docs/deploy/update.sh を再実行してください(pnpm -r build が通っているか確認)。",
  },
  {
    category: "timeout",
    label: "タイムアウト",
    pattern: /TIMEOUT|timed out|polling timed out/i,
    hint: () =>
      "処理対象が増えていないか確認してください。上限は各バッチの *_TIMEOUT_MS(stratum.env)で調整できます。",
  },
  {
    category: "transient",
    label: "外部サービス・ネットワークの一時障害",
    pattern:
      /HTTP 5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|socket hang up|Server Error/i,
    hint: (unit) =>
      `次回の定期実行で自動回復することが多いです。急ぐなら VM で systemctl --user start ${unit}`,
  },
  {
    category: "config",
    label: "設定",
    pattern: /ZodError|Invalid (input|enum|type)|yaml|ENOENT|must be|設定/i,
    hint: () => "config/*.yaml と stratum.env の該当項目を確認してください(直したら手動で再実行)。",
  },
];

/** 失敗した unit の直近ログ行から原因を分類する。純関数。 */
export function classifyFailure(lines: readonly string[], unit: string): FailureClass {
  const text = lines.join("\n");
  for (const r of RULES) {
    if (r.pattern.test(text)) return { category: r.category, label: r.label, hint: r.hint(unit) };
  }
  return {
    category: "unknown",
    label: "不明",
    hint: `VM で journalctl --user -u ${unit} -n 80 を見て原因を確認してください。`,
  };
}

/** 通知に載せるエラー行(最大 5 行・1 行 300 字・資格情報を伏せる)。 */
export function pickErrorLines(lines: readonly string[]): string[] {
  return lines
    .filter((l) => /failed|Failed|Error|error|ERR|status=/.test(l))
    .filter((l) => !l.includes("Triggering OnFailure"))
    .slice(-5)
    .map((l) => maskSecrets(l).slice(0, 300));
}

export function formatFailureMessage(unit: string, lines: readonly string[]): string {
  const picked = pickErrorLines(lines);
  const cls = classifyFailure(picked.length > 0 ? picked : lines, unit);
  const parts = [`❌ **VM タイマーが失敗しました**: ${unit}`, `原因の分類: ${cls.label}`];
  if (picked.length > 0) parts.push(`\`\`\`\n${picked.join("\n").slice(0, 1500)}\n\`\`\``);
  parts.push(`まず試すこと: ${cls.hint}`);
  parts.push(`(詳細: journalctl --user -u ${unit} -n 40)`);
  return parts.join("\n");
}

export function formatRecoveredMessage(unit: string, failedAt: string | null): string {
  const since = failedAt !== null ? `(${failedAt.slice(5, 16).replace("T", " ")} の失敗から)` : "";
  return `✅ **復旧しました**: ${unit} が正常に終わりました${since}`;
}

/** update.sh が渡す commit の件名から、利用者・運用に関係するもの(fix / feat / perf)だけを載せる。 */
export function formatDeployMessage(
  fromSha: string,
  toSha: string,
  subjects: readonly string[],
): string | null {
  const relevant = subjects
    .map((s) => s.trim())
    .filter((s) => /^(fix|feat|perf)(\(|:|!)/.test(s))
    .slice(0, 15);
  if (relevant.length === 0) return null;
  const fixes = relevant.filter((s) => s.startsWith("fix"));
  const others = relevant.filter((s) => !s.startsWith("fix"));
  const lines = [`🚀 **本番を更新しました**(${fromSha.slice(0, 7)} → ${toSha.slice(0, 7)})`];
  if (fixes.length > 0) lines.push("**直したこと**", ...fixes.map((s) => `- ${s}`));
  if (others.length > 0) lines.push("**改善・追加**", ...others.map((s) => `- ${s}`));
  return lines.join("\n");
}

// ---- 出来事の記録(週次集計用) ----

export type OpsEventKind = "failure" | "recovered" | "deploy";

export interface OpsEvent {
  ts: string;
  kind: OpsEventKind;
  unit?: string;
  category?: FailureCategory;
}

export function parseOpsEvents(jsonl: string): OpsEvent[] {
  const out: OpsEvent[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as OpsEvent;
      if (typeof e.ts === "string" && typeof e.kind === "string") out.push(e);
    } catch {
      // 壊れた行は飛ばす(追記中の途中行など)
    }
  }
  return out;
}

export interface OpsWeekly {
  failures: number;
  /** unit ごとの失敗件数と最後の分類(多い順)。 */
  byUnit: { unit: string; count: number; category: FailureCategory | undefined }[];
  recovered: number;
  deploys: number;
  /** いま失敗中のままの unit(印が残っているもの)。 */
  unresolved: readonly string[];
}

/** 直近 windowDays の出来事を集計する。since は events の ts(+09:00 の ISO)と文字列比較する。 */
export function aggregateOpsEvents(
  events: readonly OpsEvent[],
  since: string,
  unresolved: readonly string[],
): OpsWeekly {
  const win = events.filter((e) => e.ts >= since);
  const counts = new Map<string, { count: number; category: FailureCategory | undefined }>();
  for (const e of win) {
    if (e.kind !== "failure" || e.unit === undefined) continue;
    const c = counts.get(e.unit) ?? { count: 0, category: undefined };
    c.count += 1;
    c.category = e.category;
    counts.set(e.unit, c);
  }
  return {
    failures: win.filter((e) => e.kind === "failure").length,
    byUnit: [...counts.entries()]
      .map(([unit, c]) => ({ unit, ...c }))
      .sort((a, b) => b.count - a.count),
    recovered: win.filter((e) => e.kind === "recovered").length,
    deploys: win.filter((e) => e.kind === "deploy").length,
    unresolved,
  };
}

const CATEGORY_LABEL: Record<FailureCategory, string> = {
  auth: "認証・権限",
  rate_limit: "レート制限",
  transient: "一時障害",
  timeout: "タイムアウト",
  config: "設定",
  build: "ビルド",
  unknown: "不明",
};

/** 週次レポートに足す「運用」節。 */
export function formatOpsWeekly(w: OpsWeekly): string[] {
  const lines = ["**運用(VM タイマー)**"];
  if (w.failures === 0 && w.unresolved.length === 0) {
    lines.push("- 失敗なし");
  } else {
    lines.push(`- 失敗 ${w.failures} 件 / 復旧 ${w.recovered} 件`);
    for (const u of w.byUnit.slice(0, 5)) {
      const cat = u.category !== undefined ? `・${CATEGORY_LABEL[u.category]}` : "";
      lines.push(`  - ${u.unit}: ${u.count} 回${cat}`);
    }
    if (w.unresolved.length > 0) lines.push(`- ⚠️ 失敗中のまま: ${w.unresolved.join(", ")}`);
  }
  if (w.deploys > 0) lines.push(`- 本番更新 ${w.deploys} 回`);
  return lines;
}

// ---- CLI のオーケストレーション(fs と webhook は注入・テスト可能) ----

export interface OpsNotifyDeps {
  post: (content: string) => Promise<void>;
  /** 失敗中の印(失敗時刻)。無ければ null。 */
  readMarker: (unit: string) => string | null;
  writeMarker: (unit: string, ts: string) => void;
  removeMarker: (unit: string) => void;
  appendEvent: (e: OpsEvent) => void;
  now: () => string;
}

export type OpsNotifyCommand =
  | { kind: "failure"; unit: string; lines: readonly string[] }
  | { kind: "recovered"; unit: string }
  | { kind: "deploy"; fromSha: string; toSha: string; subjects: readonly string[] };

/** 1 回分の通知。投稿の失敗は呼び出し側(CLI)で握る。印と記録は投稿の成否に関わらず残す。 */
export async function runOpsNotify(cmd: OpsNotifyCommand, deps: OpsNotifyDeps): Promise<void> {
  const ts = deps.now();
  if (cmd.kind === "failure") {
    const cls = classifyFailure(pickErrorLines(cmd.lines), cmd.unit);
    if (deps.readMarker(cmd.unit) === null) deps.writeMarker(cmd.unit, ts);
    deps.appendEvent({ ts, kind: "failure", unit: cmd.unit, category: cls.category });
    await deps.post(formatFailureMessage(cmd.unit, cmd.lines));
    return;
  }
  if (cmd.kind === "recovered") {
    const failedAt = deps.readMarker(cmd.unit);
    if (failedAt === null) return; // 失敗していなかった = 通知しない(毎回の成功で騒がない)
    deps.removeMarker(cmd.unit);
    deps.appendEvent({ ts, kind: "recovered", unit: cmd.unit });
    await deps.post(formatRecoveredMessage(cmd.unit, failedAt));
    return;
  }
  const msg = formatDeployMessage(cmd.fromSha, cmd.toSha, cmd.subjects);
  deps.appendEvent({ ts, kind: "deploy" });
  if (msg !== null) await deps.post(msg);
}
