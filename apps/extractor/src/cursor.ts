/**
 * 抽出カーソル `_meta/state.json`(design.md §4.1.2 / §7.1)。処理済み minutes commit SHA を保持する。
 * knowledge-base 内の JSON(ナレッジエントリではない)なので fs で直接読み書きしてよい(kb-core 対象外)。
 * カーソルの前進は PR に含めて行い、merge 時に main へ反映される(§6.3 step6)。
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { z } from "zod";

export const extractorStateSchema = z
  .object({
    last_processed_sha: z.string().min(1),
    last_run_at: z.string().min(1),
  })
  .strict();
export type ExtractorState = z.infer<typeof extractorStateSchema>;

export function parseState(raw: string): ExtractorState {
  return extractorStateSchema.parse(JSON.parse(raw));
}

export function serializeState(state: ExtractorState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** state.json を読む。存在しない/壊れている場合は null(初回=全件処理)。 */
export async function readState(
  absPath: string,
  readFile: (p: string) => Promise<string> = (p) => fsReadFile(p, "utf8"),
): Promise<ExtractorState | null> {
  try {
    return parseState(await readFile(absPath));
  } catch {
    return null;
  }
}
