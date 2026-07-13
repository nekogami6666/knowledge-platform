/**
 * Bot 設定(channels ほか)の読み込みと検証(design.md §9.2 / §4.2 末)。
 * - channels: Bot が閲覧を許可するチャンネル。allowlist 制(default-deny、§9.2)。
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
    allow: z.array(z.string()).default([]),
    permanent_exclude: z.array(z.string()).default([]),
  })
  .default({ allow: [], permanent_exclude: [] });
export type ChannelsConfig = z.infer<typeof channelsConfigSchema>;

/**
 * 検索対象リポ(§6.2 / §14 #5)。repo="org/name"(citation allowlist 兼 permalink)、
 * dir=CLONES_DIR 配下の clone 先、url=git remote(synthetic で既存 dir を使う場合は省略可)。
 */
export const reposConfigSchema = z
  .object({
    repos: z
      .array(z.object({ repo: z.string(), dir: z.string(), url: z.string().optional() }))
      .default([]),
  })
  .default({ repos: [] });
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
  })
  .default({ channel_id: null, kb_repo: null });
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
  })
  .default({ channel_id: null, max_attachment_bytes: 25 * 1024 * 1024, daily_limit: 3 });
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

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

/** §9.2 default-deny: allow に含まれ、かつ permanent_exclude に含まれないチャンネルのみ許可。 */
export function isChannelAllowed(config: ChannelsConfig, channelId: string): boolean {
  if (config.permanent_exclude.includes(channelId)) return false;
  return config.allow.includes(channelId);
}
