/**
 * discord ソースのカーソル(ADR-0033 D3)。`_meta/extractor-discord-state.json` を KB main へ
 * **直接 commit** する(zero-yield run が常態のバックログでは PR 同梱方式がデッドロックするため。
 * 前例 = gap-tracker の質問 commit)。ナレッジ PR には同梱しない。
 * last_message_id は「処理済み or 意図的に filter した」最後の snowflake。
 */
import { z } from "zod";
import type { Logger } from "../logger.js";

export const DISCORD_STATE_PATH = "_meta/extractor-discord-state.json";

const channelCursorSchema = z
  .object({
    last_message_id: z.string().min(1),
    last_processed_at: z.string().min(1),
  })
  .strict();

export const discordStateSchema = z
  .object({
    version: z.literal(1),
    channels: z.record(z.string(), channelCursorSchema),
    last_run_at: z.string().min(1),
  })
  .strict();
export type DiscordState = z.infer<typeof discordStateSchema>;

/**
 * state を読む。raw=null(不在)は初回として null(= now − backfill_days から)。
 * parse 失敗も warn + null(カーソルは派生物で、失い方は「backfill 分の再読」= デデュープ③⑤が
 * 受けるため fail-loud にしない)。
 */
export function readDiscordState(raw: string | null, logger?: Logger): DiscordState | null {
  if (raw === null) return null;
  try {
    const parsed = discordStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    logger?.warn("extractor-discord-state.json がスキーマ不一致のため初回扱いにします", {
      issue: parsed.error.issues[0]?.message ?? "unknown",
    });
  } catch (e) {
    logger?.warn("extractor-discord-state.json を JSON として読めないため初回扱いにします", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

/** 決定的な直列化(チャンネル ID 昇順)。 */
export function serializeDiscordState(state: DiscordState): string {
  const channels: DiscordState["channels"] = {};
  for (const id of Object.keys(state.channels).sort()) {
    channels[id] = state.channels[id] as DiscordState["channels"][string];
  }
  return `${JSON.stringify({ version: 1, channels, last_run_at: state.last_run_at }, null, 2)}\n`;
}

/** Discord epoch(2015-01-01T00:00:00Z)。 */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/**
 * 指定時刻に対応する snowflake(その時刻ちょうどの仮想 ID)。初回カーソル無しのとき
 * `after=snowflakeForDate(now − backfill_days)` で「直近 N 日から前方のみ」を実現する(D9)。
 */
export function snowflakeForDate(date: Date): string {
  const ms = Math.max(0, date.getTime() - DISCORD_EPOCH_MS);
  return (BigInt(ms) << 22n).toString();
}
