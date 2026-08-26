/**
 * discord ソースの設定(ADR-0033)。`apps/extractor/config/discord.yaml`(gitignore・example のみ
 * commit)。targets は**新設のオプトイン allowlist**(空 = 機能 OFF)— channels.yaml の旧 `allow`
 * (ADR-0018 で廃止)とは別物で、bot 可視 ∧ ¬permanent_exclude のゲートの**上に**重ねる。
 * caps は P4(網羅的事前文書化の禁止)とコスト有界(D7)の要。
 */
import { z } from "zod";

export const discordSourceConfigSchema = z
  .object({
    /** 収集対象チャンネル ID の allowlist。空 = 機能 OFF(deploy 済みでも安全な既定)。 */
    targets: z.array(z.string()).default([]),
    kb: z
      .object({
        repo: z.string().min(1),
        dir: z.string().default("knowledge-base"),
        /** clone URL。トークンは書かず GIT_CLONE_TOKEN(env)から実行時注入(#139)。 */
        url: z.string().optional(),
      })
      .strict(),
    base_branch: z.string().default("main"),
    /** 初回(カーソル無し)の遡り日数。以後は前進のみ(ADR-0033 D9)。 */
    backfill_days: z.number().int().positive().default(90),
    /** 1 run で処理するチャンネル数(D7)。超過分は次回(日替わりローテーション)。 */
    max_channels: z.number().int().positive().default(2),
    /** 1 チャンネルあたりの取得メッセージ数上限(D7)。超過分はカーソルの先に残る。 */
    max_messages_per_channel: z.number().int().positive().default(200),
    /** 1 run の LLM 抽出呼び出し上限(D7)。超過ウィンドウは次回(カーソルを進めない)。 */
    max_extract_calls: z.number().int().positive().default(8),
    /** この分数以上会話が途切れたらウィンドウを区切る(D2)。 */
    window_gap_minutes: z.number().int().positive().default(30),
    /** 1 ウィンドウの最大メッセージ数(D2)。 */
    window_max_messages: z.number().int().positive().default(50),
    /** PR 通知のレビュー担当メンション(日替わり・nightly の review_mentions と同運用)。 */
    review_mentions: z.array(z.string()).default([]),
  })
  .strict();
export type DiscordSourceConfig = z.infer<typeof discordSourceConfigSchema>;

export interface ConfigReader {
  read(name: string): Promise<string>;
}

export async function loadDiscordSourceConfig(reader: ConfigReader): Promise<DiscordSourceConfig> {
  const { load } = await import("js-yaml");
  const raw = await reader.read("discord.yaml");
  return discordSourceConfigSchema.parse(load(raw));
}

/**
 * cap 時の対象ローテーション(pr-miner rotateTargets と同型・日替わり起点)。
 * max_channels < targets のとき、毎 run 同じ先頭だけ処理して残りが飢餓しないように回す。
 */
export function rotateChannels(channelIds: readonly string[], now: Date): string[] {
  if (channelIds.length <= 1) return [...channelIds];
  const start = Math.floor(now.getTime() / 86_400_000) % channelIds.length;
  return [...channelIds.slice(start), ...channelIds.slice(0, start)];
}
