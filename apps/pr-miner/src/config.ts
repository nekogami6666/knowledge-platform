/**
 * pr-miner 設定(design.md §6.4 ③-c / §12.2: リポジトリ名はハードコードせず config から)。
 * `pr-miner.yaml` に対象リポ群(targets)・KB リポ・base ブランチ・対象期間を持つ。
 * targets は既定 [](空 = 機能 OFF。§14#5 の対象リポ決定前でも安全にマージできる)。
 * 読み取りは注入可能(テスト用。extractor/config.ts と同形のアプリ内コピー)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export const prMinerConfigSchema = z
  .object({
    /** マイニング対象の開発リポジトリ群("org/name")。空 = 機能 OFF(§14#5 未決)。 */
    targets: z.array(z.string().min(1)).default([]),
    /** 提案 PR を出す KB リポ。 */
    kb: z.object({ repo: z.string().min(1) }),
    /** PR のベースブランチ。 */
    base_branch: z.string().default("main"),
    /** 遡る日数(初回カーソル無し時の since を now − window_days で決める)。 */
    window_days: z.number().int().positive().default(7),
    /**
     * 1 run で materialize する PR 数の上限(全リポ合計)。未指定 = 無制限(現挙動)。
     * extractor の EXTRACTOR_MAX_FILES(ADR-0023 D3)と同型: バックログをコスト有界で少量ずつ消化する。
     * cap 到達分は次回へ持ち越し(カーソルは処理した PR までしか前進しない)。
     */
    max_prs: z.number().int().positive().optional(),
  })
  .strict();
export type PrMinerConfig = z.infer<typeof prMinerConfigSchema>;

export interface ConfigReader {
  read(name: string): Promise<string | null>;
}

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

export async function loadPrMinerConfig(reader: ConfigReader): Promise<PrMinerConfig> {
  const text = await reader.read("pr-miner.yaml");
  if (text === null) {
    throw new Error("pr-miner.yaml が見つかりません(CONFIG_DIR を確認してください)");
  }
  return prMinerConfigSchema.parse(yaml.load(text));
}
