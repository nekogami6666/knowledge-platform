/**
 * extractor 設定(design.md §12.2: リポジトリ名はハードコードせず config から)。
 * `extractor.yaml` に minutes / knowledge-base のリポ指定(RepoSpec)+ base ブランチを持つ。
 * 読み取りは注入可能(テスト用)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const repoSpecSchema = z.object({
  /** "org/name"(出典 repo + PR 対象)。 */
  repo: z.string().min(1),
  /** CLONES_DIR 配下の clone ディレクトリ名。 */
  dir: z.string().min(1),
  /** git remote URL(省略時は既に checkout 済みの dir を使う)。 */
  url: z.string().optional(),
});

/** minutes は抽出対象から外す basename を持てる(既定 transcript.md。生書き起こしは重く冗長)。 */
const minutesSpecSchema = repoSpecSchema.extend({
  exclude: z.array(z.string()).default(["transcript.md"]),
});

/**
 * interviews は KB リポ内のディレクトリ(§4.1 / §6.6 ⑤-b・PR-I1)なので repo 指定は不要。
 * kits/(質問リスト)と voice-memos/(capture 経路の原本・§6.4 ③-b)は抽出対象外。
 */
const interviewsSpecSchema = z
  .object({
    dir: z.string().default("interviews"),
    exclude_dirs: z.array(z.string()).default(["kits", "voice-memos"]),
  })
  .strict();

export const extractorConfigSchema = z
  .object({
    minutes: minutesSpecSchema,
    kb: repoSpecSchema,
    interviews: interviewsSpecSchema.default({}),
    base_branch: z.string().default("main"),
  })
  .strict();
export type ExtractorConfig = z.infer<typeof extractorConfigSchema>;
export type RepoSpec = z.infer<typeof repoSpecSchema>;
export type MinutesSpec = z.infer<typeof minutesSpecSchema>;
export type InterviewsSpec = z.infer<typeof interviewsSpecSchema>;

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

export async function loadExtractorConfig(reader: ConfigReader): Promise<ExtractorConfig> {
  const text = await reader.read("extractor.yaml");
  if (text === null) {
    throw new Error("extractor.yaml が見つかりません(CONFIG_DIR を確認してください)");
  }
  return extractorConfigSchema.parse(yaml.load(text));
}
