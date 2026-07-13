/**
 * expertise-mapper 設定(design.md §6.6 ⑤-a / ADR-0017・§12.2: リポジトリ名はハードコードしない)。
 * `expertise-mapper.yaml`(KB 側の expertise/expertise.yaml と紛れない名前)に対象リポ群・KB リポ・
 * commit の遡り日数を持つ。
 * pr-miner と異なり **targets 空でも機能 OFF にしない** — KB evidence 単独でマップは成立する
 * (v1 の価値の半分は KB 由来)。全体の ON/OFF は workflow の vars ガード(M5)。
 * 読み取りは注入可能(pr-miner/config.ts と同形のアプリ内コピー)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export const expertiseMapperConfigSchema = z
  .object({
    /** commit evidence の対象リポ群("org/name")。空 = commit コレクタのみスキップ。 */
    targets: z.array(z.string().min(1)).default([]),
    /** expertise.yaml / reports を commit する KB リポ。 */
    kb: z.object({ repo: z.string().min(1) }),
    /** commit 先ブランチ(main 直 commit・ADR-0017 D5)。 */
    base_branch: z.string().default("main"),
    /** commit evidence の遡り日数(§6.6 の「直近 90 日」に整合)。 */
    window_days: z.number().int().positive().default(90),
  })
  .strict();
export type ExpertiseMapperConfig = z.infer<typeof expertiseMapperConfigSchema>;

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

export async function loadExpertiseMapperConfig(
  reader: ConfigReader,
): Promise<ExpertiseMapperConfig> {
  const text = await reader.read("expertise-mapper.yaml");
  if (text === null) {
    throw new Error("expertise-mapper.yaml が見つかりません(CONFIG_DIR を確認してください)");
  }
  return expertiseMapperConfigSchema.parse(yaml.load(text));
}
