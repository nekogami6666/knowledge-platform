/**
 * gap-tracker 設定(design.md §6.5 / §12.2: リポ名・人はハードコードしない)。
 * gap.yaml: knowledge-base リポ + 回答者候補(github↔discord)。
 * expertise.yaml(§4.5)は Phase 4(C6)で生成されるため、それまでは assignees の
 * ラウンドロビンが既定(存在すれば expertise を優先する hook は selectAssignee 側)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const assigneeSchema = z.object({
  /** 表示名(任意・gap.yaml の可読性用・ADR-0022)。選定/記録には使わない。 */
  name: z.string().min(1).optional(),
  /** GitHub ユーザ名(任意・ADR-0022)。expertise 突合と KB 記録に使う。未所持者は省略。 */
  github: z.string().min(1).optional(),
  /** Discord ユーザ ID(**主キー**・ADR-0022)。選定・予約・依頼メンション <@id> のキー。 */
  discord: z.string().min(1),
});
export type Assignee = z.infer<typeof assigneeSchema>;

export const gapConfigSchema = z
  .object({
    /** "org/knowledge-base"(質問ログの commit 先)。 */
    kb_repo: z.string().min(1),
    /** CLONES_DIR 配下の KB clone ディレクトリ名。 */
    kb_dir: z.string().min(1),
    /** git remote URL(省略時は checkout 済みの dir を使う)。 */
    kb_url: z.string().optional(),
    base_branch: z.string().default("main"),
    /** 回答者候補(ラウンドロビン。週3件/人の上限は §6.5 L501)。**空にすると members.yaml 全員が
     * プールになる**(ADR-0022・「皆で OK」)。 */
    assignees: z.array(assigneeSchema).default([]),
  })
  .strict();
export type GapConfig = z.infer<typeof gapConfigSchema>;

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

export async function loadGapConfig(reader: ConfigReader): Promise<GapConfig> {
  const text = await reader.read("gap.yaml");
  if (text === null) {
    throw new Error("gap.yaml が見つかりません(CONFIG_DIR を確認してください)");
  }
  return gapConfigSchema.parse(yaml.load(text));
}
