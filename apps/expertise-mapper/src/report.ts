/**
 * 週次レポート `expertise/reports/<YYYY-MM-DD>.md` の生成(design.md §6.6 ⑤-a step3)。
 * validateRepo の走査対象外(自由 markdown)。前週比とトピック名安定率を毎回自動記載し、
 * AC「名前が週跨ぎ 9 割以上安定」(§6.6)を運用の中で機械的に観測できるようにする。
 */
import { type ExpertiseMap, type Members, nameForGithub } from "@stratum/kb-core";

/** JST の日付キー(YYYY-MM-DD)。cron が深夜 JST のため UTC 日付だと前日になり混乱する。 */
export function reportDateKey(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** JST 固定オフセットの ISO 8601(isoDateTimeSchema 準拠。gap-tracker close.ts の isoJst と同形)。 */
export function toJstIso(now: Date): string {
  return `${new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
}

/** トピック名の安定率: |前回 ∩ 今回| / |前回|。前回が無ければ null(初回)。 */
export function stabilityRate(
  prev: readonly string[],
  next: readonly string[],
): { kept: number; total: number } | null {
  if (prev.length === 0) return null;
  const nextSet = new Set(next);
  return { kept: prev.filter((t) => nextSet.has(t)).length, total: prev.length };
}

export interface ReportInput {
  date: string;
  prev: ExpertiseMap | null;
  next: ExpertiseMap;
  mapChanged: boolean;
  /** 未クラスタ(LLM が割当を返さなかった)material.id。 */
  unassigned: readonly string[];
  /** author login が引けなかった commit 数(リポ別)。 */
  unattributedCommits: Readonly<Record<string, number>>;
  /** 読み取りに失敗した対象リポ(権限確認の促し)。 */
  failedRepos: readonly string[];
  /** 集計サマリ。 */
  kbMaterials: number;
  repoMaterials: number;
  /** 表示名の写像用(github login → フルネーム・ADR-0022)。 */
  members: Members;
}

export function buildReport(input: ReportInput): string {
  const { prev, next } = input;
  const lines: string[] = [
    `# 専門性マップ 週次レポート(${input.date})`,
    "",
    `- 対象: KB エントリ ${input.kbMaterials} 件・対象リポ ${input.repoMaterials} 個 → トピック ${next.topics.length} 件`,
  ];
  if (!input.mapChanged) {
    lines.push("- **変化なし**(expertise.yaml は更新していません)");
  }
  for (const [repo, n] of Object.entries(input.unattributedCommits)) {
    lines.push(`- author 不明で除外した commit: ${repo} ${n} 件(GitHub アカウント未紐付け)`);
  }
  for (const repo of input.failedRepos) {
    lines.push(`- ⚠️ 読み取り失敗: ${repo}(PAT の権限を確認してください)`);
  }

  const high = next.topics.filter((t) => t.risk === "high");
  lines.push("", "## risk: high(インタビュー候補・§6.6 ⑤-b)", "");
  if (high.length === 0) {
    lines.push("なし");
  } else {
    lines.push(
      "| topic | label | 上位者 | bus_factor | documented_kb_count |",
      "|---|---|---|---|---|",
    );
    for (const t of high) {
      const topLogin = t.people[0]?.name;
      // people[].name は github login。表示はフルネーム優先(ADR-0022)。
      const topName = topLogin ? (nameForGithub(input.members, topLogin) ?? topLogin) : "-";
      lines.push(
        `| ${t.topic} | ${t.label} | ${topName} | ${t.bus_factor} | ${t.documented_kb_count} |`,
      );
    }
  }

  lines.push("", "## 前週比", "");
  if (prev === null) {
    lines.push("初回生成(前回のマップなし)");
  } else {
    const prevIds = prev.topics.map((t) => t.topic);
    const nextIds = new Set(next.topics.map((t) => t.topic));
    const prevSet = new Set(prevIds);
    const added = next.topics.filter((t) => !prevSet.has(t.topic));
    const removed = prevIds.filter((t) => !nextIds.has(t));
    const riskChanged = next.topics.filter((t) => {
      const p = prev.topics.find((x) => x.topic === t.topic);
      return p !== undefined && p.risk !== t.risk;
    });
    lines.push(
      `- 新規トピック: ${added.length > 0 ? added.map((t) => `${t.topic}(${t.label})`).join(", ") : "なし"}`,
      `- 消滅トピック: ${removed.length > 0 ? removed.join(", ") : "なし"}`,
      `- risk 変化: ${
        riskChanged.length > 0
          ? riskChanged
              .map(
                (t) =>
                  `${t.topic} ${prev.topics.find((x) => x.topic === t.topic)?.risk} → ${t.risk}`,
              )
              .join(", ")
          : "なし"
      }`,
    );
    const s = stabilityRate(prevIds, [...nextIds]);
    if (s !== null) {
      const pct = Math.floor((s.kept * 100) / s.total);
      lines.push(
        `- トピック名安定率: ${s.kept}/${s.total}(${pct}%)${pct < 90 ? " ⚠️ AC(9 割)未達" : ""}`,
      );
    }
  }

  lines.push("", "## 未クラスタ material(LLM が割当を返さなかったもの)", "");
  lines.push(...(input.unassigned.length > 0 ? input.unassigned.map((id) => `- ${id}`) : ["なし"]));

  lines.push(
    "",
    "## 未マッピング(将来枠)",
    "",
    "v1 の evidence は KB + commit のみ(ADR-0017 D2/D7)。議事録・Discord evidence の導入時に、",
    "対応表(_meta/members.yaml)で引けなかった発言者をここへ列挙する。",
    "",
  );
  return lines.join("\n");
}
