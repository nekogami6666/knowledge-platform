/**
 * Bot 設定(channels / members)の読み込みと検証(design.md §9.2 / §4.2 末)。
 * - channels: Bot が閲覧を許可するチャンネル。allowlist 制(default-deny、§9.2)。
 * - members: GitHub ユーザ名 ↔ Discord ユーザ ID マッピング(§14 #8 未決。空で可)。
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

export const membersConfigSchema = z
  .object({
    members: z.array(z.object({ github: z.string(), discord: z.string() })).default([]),
  })
  .default({ members: [] });
export type MembersConfig = z.infer<typeof membersConfigSchema>;

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
 * 承認者はチャンネルに入れる人間なら誰でも(チャンネル参加=信頼境界。members.yaml 整備後に締める)。
 */
export const opsConfigSchema = z
  .object({
    channel_id: z.string().nullable().default(null),
    kb_repo: z.string().nullable().default(null),
  })
  .default({ channel_id: null, kb_repo: null });
export type OpsConfig = z.infer<typeof opsConfigSchema>;

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

export async function loadMembers(reader: ConfigReader): Promise<MembersConfig> {
  const text = await reader.read("members.yaml");
  const data = text === null ? undefined : yaml.load(text);
  return membersConfigSchema.parse(data ?? undefined);
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

/** §9.2 default-deny: allow に含まれ、かつ permanent_exclude に含まれないチャンネルのみ許可。 */
export function isChannelAllowed(config: ChannelsConfig, channelId: string): boolean {
  if (config.permanent_exclude.includes(channelId)) return false;
  return config.allow.includes(channelId);
}

/** Discord ユーザ ID → GitHub ユーザ名(未マップは undefined)。 */
export function githubForDiscord(config: MembersConfig, discordId: string): string | undefined {
  return config.members.find((m) => m.discord === discordId)?.github;
}
