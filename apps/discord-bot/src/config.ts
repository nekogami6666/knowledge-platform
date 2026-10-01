/**
 * Bot 設定(channels ほか)の読み込みと検証(design.md §9.2 / §4.2 末)。
 * - channels: 読み取り可否は Discord のロール可視性(bot の ViewChannel)で決まる(ADR-0018)。
 *   config に残るのは「公開だが読ませないチャンネル」の明示除外(permanent_exclude・§9.3)のみ。
 * - members 対応表はローカル config ではなく KB の `_meta/members.yaml` が唯一の正
 *   (ADR-0017 D3。読み込みは members.ts の createCloneMembersLoader)。
 * 読み取りは注入可能にしてテストする(ファイルが無ければ既定値)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export const channelsConfigSchema = z
  .object({
    /** @deprecated ADR-0018 で廃止。判定には使わない(残っていれば index.ts が警告して無視)。 */
    allow: z.array(z.string()).optional(),
    permanent_exclude: z.array(z.string()).default([]),
  })
  .default({ permanent_exclude: [] });
export type ChannelsConfig = z.infer<typeof channelsConfigSchema>;

/**
 * チャンネルゲートの入力(discord.js から剥がした純粋データ・ADR-0018)。
 * 変換は visibility.ts(gateInputFromChannel / gateInputFromInteraction)が担う。
 */
export interface ChannelGateInput {
  channelId: string;
  /** スレッド / フォーラム投稿の親チャンネル ID(permanent_exclude の照合用)。 */
  parentId: string | null;
  /** bot 自身が ViewChannel を持つか。null = 判定不能(安全側 = 拒否)。 */
  botCanView: boolean | null;
}

/**
 * org 可視リポの自動列挙(ADR-0036 D1。明示オプトイン・既定 null = OFF)。
 * - org: GitHub の org 名(`GET /orgs/{org}/repos` をトークンの可視範囲で列挙)。
 * - exclude: 列挙から外すリポ名("name" or "org/name"・大小無視の完全一致。D3)。
 *   **列挙分にだけ効く**。`repos:` の手動指定は明示の意図として除外しない(repo-scope.ts)。
 * - sync_on_ask: /ask のたびに同期するリポ名パターン(`*` のみの簡易 glob・大小無視。D5)。
 *   それ以外の列挙分は定期同期のみ。
 */
export const allVisibleConfigSchema = z.object({
  org: z.string().min(1),
  exclude: z.array(z.string()).default([]),
  sync_on_ask: z.array(z.string()).default([]),
});
export type AllVisibleConfig = z.infer<typeof allVisibleConfigSchema>;

/**
 * 検索対象リポ(§6.2 / §14 #5)。repo="org/name"(citation allowlist 兼 permalink)、
 * dir=CLONES_DIR 配下の clone 先、url=git remote(synthetic で既存 dir を使う場合は省略可)。
 * all_visible があれば列挙分と和集合にする(repos: 側が優先・ADR-0036 D1)。
 */
export const reposConfigSchema = z
  .object({
    repos: z
      .array(z.object({ repo: z.string(), dir: z.string(), url: z.string().optional() }))
      .default([]),
    all_visible: allVisibleConfigSchema.nullable().default(null),
  })
  .default({ repos: [], all_visible: null });
export type ReposConfig = z.infer<typeof reposConfigSchema>;

/**
 * 👍 代理マージ(§6.3 / C1 拡張)の設定。両方が設定されて初めて機能が有効になる(既定 OFF)。
 * - channel_id: extractor が PR 通知を投稿する #stratum-ops のチャンネル ID。
 * - kb_repo: マージを許可する唯一のリポ("org/knowledge-base")。他リポの URL は拒否。
 * 承認者はチャンネルに入れる人間なら誰でも(チャンネル参加=信頼境界。KB の _meta/members.yaml 整備後に締める)。
 */
export const opsConfigSchema = z
  .object({
    channel_id: z.string().nullable().default(null),
    kb_repo: z.string().nullable().default(null),
    /**
     * /ask を使えるメンバーのロール ID(ADR-0036 D7)。いずれか 1 つを持っていれば使える。
     * 検索対象に private リポが入る一方、Discord には社外メンバーもいるため社内のチームロールに限定する。
     * 空 = 全員が使える(従来どおり)。
     */
    ask_role_ids: z.array(z.string()).default([]),
  })
  .default({ channel_id: null, kb_repo: null, ask_role_ids: [] });
export type OpsConfig = z.infer<typeof opsConfigSchema>;

/**
 * voice-memo(§6.4 ③-b / ADR-0015)の設定。channel_id が設定されて初めて機能が有効になる(既定 OFF)。
 * - channel_id: 音声メモ専用チャンネル(#voice-memo)。channels.yaml の allow にも入れること(§9.2)。
 * - max_attachment_bytes: 受け付ける音声添付の上限(ADR-0015 D6。既定 25MB = OpenAI API の上限)。
 * - daily_limit: user 1 日あたりの受付件数(💡 capture と同じ乱用対策)。
 */
export const voiceConfigSchema = z
  .object({
    channel_id: z.string().nullable().default(null),
    max_attachment_bytes: z
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    daily_limit: z.number().int().positive().default(3),
    /** VC 録音の専用ボイスチャンネル(ADR-0020 D3。null = VC 入口 OFF)。 */
    vc_channel_id: z.string().nullable().default(null),
    /** VC 録音の自動 finalize 上限(分・ADR-0020 D3。STT 25MB 上限に収める)。 */
    max_recording_minutes: z.number().int().positive().default(15),
    /** interview セッション "armed" の失効(分・ADR-0028 D5。誰も VC に入らないまま超過で cancelled)。 */
    interview_arm_ttl_minutes: z.number().int().positive().default(120),
    /** 面談パネル(常設 embed)の設置チャンネル(ADR-0028 UI。null = パネル OFF。VC 内蔵テキストチャット可)。 */
    interview_panel_channel_id: z.string().nullable().default(null),
  })
  .default({
    channel_id: null,
    max_attachment_bytes: 25 * 1024 * 1024,
    daily_limit: 3,
    vc_channel_id: null,
    max_recording_minutes: 15,
    interview_arm_ttl_minutes: 120,
    interview_panel_channel_id: null,
  });
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

/**
 * Discord 本文インデックス(ADR-0038)の設定。`enabled: true` で初めて有効になる(既定 OFF =
 * DB を作らずイベントも購読しない)。既定値の理由は ADR-0038 D9。
 * - backfill_days: カーソルが無いチャンネルの初回取り込み範囲(extractor と同じ 90 日)。
 * - retention_days: 本文の保持期間(これより古い本文は定期照合で削除)。backfill_days 以上。
 * - reconcile_interval_hours / reconcile_window_days: 停止中の編集・削除を反映する定期照合の周期と範囲。
 * - max_results: discord_search 1 回で返す上限件数。
 * - max_fetch_per_channel: 1 周期でチャンネルあたりに REST で取得する上限(残りは次の周期でカーソルから)。
 */
export const discordIndexConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    backfill_days: z.number().int().positive().default(90),
    retention_days: z.number().int().positive().default(180),
    reconcile_interval_hours: z.number().positive().default(6),
    reconcile_window_days: z.number().int().positive().default(7),
    max_results: z.number().int().positive().max(100).default(20),
    max_fetch_per_channel: z.number().int().positive().default(10_000),
  })
  .superRefine((c, ctx) => {
    // 取り込んだ直後に保持期間で消える設定を拒否する(取り込みと削除の空回り)。
    if (c.retention_days < c.backfill_days) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retention_days"],
        message: "retention_days は backfill_days 以上にしてください",
      });
    }
    if (c.reconcile_window_days > c.retention_days) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reconcile_window_days"],
        message: "reconcile_window_days は retention_days 以下にしてください",
      });
    }
  })
  .default({});
export type DiscordIndexConfig = z.infer<typeof discordIndexConfigSchema>;

/** 設定ファイルの読み取り口。ファイルが無ければ null を返す(= 既定値を使う)。 */
export interface ConfigReader {
  read(name: string): Promise<string | null>;
}

/** config ディレクトリ配下の `<name>` を読む既定リーダ(存在しなければ null)。 */
export function createFsConfigReader(dir: string): ConfigReader {
  return {
    async read(name) {
      try {
        return await readFile(join(dir, name), "utf8");
      } catch {
        return null;
      }
    },
  };
}

export async function loadChannels(reader: ConfigReader): Promise<ChannelsConfig> {
  const text = await reader.read("channels.yaml");
  const data = text === null ? undefined : yaml.load(text);
  return channelsConfigSchema.parse(data ?? undefined);
}

export async function loadRepos(reader: ConfigReader): Promise<ReposConfig> {
  const text = await reader.read("repos.yaml");
  const data = text === null ? undefined : yaml.load(text);
  return reposConfigSchema.parse(data ?? undefined);
}

export async function loadOps(reader: ConfigReader): Promise<OpsConfig> {
  const text = await reader.read("ops.yaml");
  const data = text === null ? undefined : yaml.load(text);
  return opsConfigSchema.parse(data ?? undefined);
}

export async function loadVoice(reader: ConfigReader): Promise<VoiceConfig> {
  const text = await reader.read("voice.yaml");
  const data = text === null ? undefined : yaml.load(text);
  return voiceConfigSchema.parse(data ?? undefined);
}

export async function loadDiscordIndex(reader: ConfigReader): Promise<DiscordIndexConfig> {
  const text = await reader.read("discord-index.yaml");
  const data = text === null ? undefined : yaml.load(text);
  return discordIndexConfigSchema.parse(data ?? undefined);
}

/**
 * §9.2(ADR-0018): permanent_exclude(スレッドは親 ID でも照合)→ bot の可視性の順で判定する。
 * 「bot(専用ロール)が見えるチャンネル = 読む」。判定不能(botCanView: null)は拒否(安全側)。
 */
export function isChannelAllowed(config: ChannelsConfig, gate: ChannelGateInput): boolean {
  if (config.permanent_exclude.includes(gate.channelId)) return false;
  if (gate.parentId !== null && config.permanent_exclude.includes(gate.parentId)) return false;
  return gate.botCanView === true;
}

/**
 * /ask の利用者ゲート(ADR-0036 D7)。askRoleIds が空なら全員を通す(従来どおり)。
 * いずれか 1 つのロールを持っていれば通す。メンバーのロールが判定できない(memberRoleIds: null)
 * 場合は拒否する(安全側)。
 */
export function isAskAllowedByRole(
  askRoleIds: readonly string[],
  memberRoleIds: readonly string[] | null,
): boolean {
  if (askRoleIds.length === 0) return true;
  if (memberRoleIds === null) return false;
  return askRoleIds.some((id) => memberRoleIds.includes(id));
}
