/**
 * pr-miner カーソル `_meta/pr-miner-state.json`(design.md §4.1.2 / §7.1)。
 * リポごとに「最後に処理したマージ時刻(last_merged_at)」を保持し、次回はそれ以降のみ列挙する。
 * knowledge-base 内の JSON(ナレッジエントリではない)なので fs で直接読み書きしてよい(kb-core 対象外・
 * extractor cursor.ts と同方針。validateRepo は _meta/ を走査しない)。
 * カーソルの前進は提案 PR に含めて行い、merge 時に main へ反映される(extractor と同じ「自分の PR がカーソルを進める」)。
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { z } from "zod";

export const prMinerStateSchema = z
  .object({
    /** "org/name" → 最後に処理した PR のマージ時刻(ISO 8601)。 */
    repos: z.record(z.object({ last_merged_at: z.string().min(1) }).strict()),
    last_run_at: z.string().min(1),
  })
  .strict();
export type PrMinerState = z.infer<typeof prMinerStateSchema>;

export function parseState(raw: string): PrMinerState {
  return prMinerStateSchema.parse(JSON.parse(raw));
}

export function serializeState(state: PrMinerState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** state.json を読む。存在しない/壊れている場合は null(初回=window_days 分を遡る)。 */
export async function readState(
  absPath: string,
  readFile: (p: string) => Promise<string> = (p) => fsReadFile(p, "utf8"),
): Promise<PrMinerState | null> {
  try {
    return parseState(await readFile(absPath));
  } catch {
    return null;
  }
}
