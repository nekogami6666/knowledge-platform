/**
 * Discord snowflake の小道具(ADR-0038)。TEXT のままでは桁数が違うと順序が崩れるため BigInt で比べる。
 * extractor にも同じ計算(state.ts の snowflakeForDate)があるが、extractor は discord-bot に依存する側で
 * 逆向きに import できないため、ここに最小限を置く。
 */

/** Discord epoch(2015-01-01T00:00:00Z)。 */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** 指定時刻ちょうどの仮想 snowflake(`after=` の下端に使う)。 */
export function snowflakeForMs(ms: number): string {
  return (BigInt(Math.max(0, ms - DISCORD_EPOCH_MS)) << 22n).toString();
}

/** snowflake の作成時刻(epoch ms)。 */
export function snowflakeToMs(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}

/** snowflake の数値比較(負 = a が古い)。 */
export function compareSnowflake(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
