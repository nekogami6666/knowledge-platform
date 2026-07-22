/**
 * 抽出カーソル `_meta/state.json`(design.md §4.1.2 / §7.1)。ソース別の処理済み commit SHA を保持する
 * (minutes = 議事録リポ / interviews = KB リポの interviews/・PR-I1)。
 * knowledge-base 内の JSON(ナレッジエントリではない)なので fs で直接読み書きしてよい(kb-core 対象外)。
 * カーソルの前進は PR に含めて行い、merge 時に main へ反映される(§6.3 step6)。
 * 旧形式(単一 last_processed_sha = minutes のみの時代)は読み取り時に minutes カーソルへ移行する。
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { z } from "zod";

const sourceCursorSchema = z
  .object({
    last_processed_sha: z.string().min(1),
    /** 上限超過・抽出失敗で次回へ持ち越すファイル(repo 相対パス)。空なら省略(ADR-0023 D2)。 */
    pending: z.array(z.string()).optional(),
  })
  .strict();
export type SourceCursor = z.infer<typeof sourceCursorSchema>;

const currentStateSchema = z
  .object({
    sources: z
      .object({
        minutes: sourceCursorSchema.optional(),
        interviews: sourceCursorSchema.optional(),
      })
      .strict(),
    last_run_at: z.string().min(1),
  })
  .strict();

/** 旧形式(PR-I1 以前)。minutes 単一ソース時代の SHA を minutes カーソルとして読み替える。 */
const legacyStateSchema = z
  .object({
    last_processed_sha: z.string().min(1),
    last_run_at: z.string().min(1),
  })
  .strict()
  .transform(
    (s): ExtractorState => ({
      sources: { minutes: { last_processed_sha: s.last_processed_sha } },
      last_run_at: s.last_run_at,
    }),
  );

export const extractorStateSchema = z.union([currentStateSchema, legacyStateSchema]);
export type ExtractorState = z.infer<typeof currentStateSchema>;

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
