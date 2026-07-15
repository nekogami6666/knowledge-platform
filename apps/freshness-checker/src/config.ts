/**
 * freshness-checker 設定(design.md §6.7 / §12.2: リポ名・上限値はハードコードしない)。
 * freshness.yaml: knowledge-base リポ + 確認 DM の頻度制御(ADR-0019 D2/D4)。
 * owner→Discord の対応は config ではなく KB の _meta/members.yaml が唯一の正(ADR-0017 D3)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export const freshnessConfigSchema = z
  .object({
    /** "org/knowledge-base"(stale 降格の commit 先)。 */
    kb_repo: z.string().min(1),
    /** CLONES_DIR 配下の KB clone ディレクトリ名。 */
    kb_dir: z.string().min(1),
    /** git remote URL(省略時は checkout 済みの dir を使う)。 */
    kb_url: z.string().optional(),
    base_branch: z.string().default("main"),
    /** 1 人 1 日あたりの確認 DM 上限(§6.7 / ADR-0019 D2)。 */
    daily_limit_per_owner: z.number().int().positive().default(2),
    /** 無応答でエントリを status: stale へ降格するまでの日数(ADR-0019 D4)。 */
    stale_after_days: z.number().int().positive().default(14),
  })
  .strict();
export type FreshnessConfig = z.infer<typeof freshnessConfigSchema>;

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

export async function loadFreshnessConfig(reader: ConfigReader): Promise<FreshnessConfig> {
  const text = await reader.read("freshness.yaml");
  if (text === null) {
    throw new Error("freshness.yaml が見つかりません(CONFIG_DIR を確認してください)");
  }
  return freshnessConfigSchema.parse(yaml.load(text));
}
