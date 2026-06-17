/**
 * ゴールデン質問セット(design.md §10.2)の読み込み + 検証。
 * `expected_sources` は discord-bot の QA 契約 `qaCitationSchema` を再利用する(型再定義禁止 §12.2)。
 */
import { qaCitationSchema } from "@stratum/discord-bot/qa";
import yaml from "js-yaml";
import { z } from "zod";

/** ゴールデン 1 問。expected_sources は QaCitation 形(NOT_FOUND ケースは空配列 + not_found:true)。 */
export const goldenQaSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    expected_sources: z.array(qaCitationSchema),
    answer_points: z.array(z.string()).default([]),
    not_found: z.boolean().default(false),
  })
  .strict();
export type GoldenQa = z.infer<typeof goldenQaSchema>;

export const goldenQaFileSchema = z.array(goldenQaSchema);

/** YAML 文字列を読み、zod で検証して GoldenQa[] を返す。 */
export function loadGoldenQa(raw: string): GoldenQa[] {
  const data = yaml.load(raw);
  return goldenQaFileSchema.parse(data);
}
