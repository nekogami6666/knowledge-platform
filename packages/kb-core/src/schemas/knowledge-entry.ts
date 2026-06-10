import { z } from "zod";
import {
  confidenceSchema,
  DEFAULT_REVIEW_INTERVAL_DAYS,
  dateOnlySchema,
  entryStatusSchema,
  entryTypeSchema,
  kbIdSchema,
} from "./common.js";
import { sourcesSchema } from "./source.js";

/** ナレッジエントリの frontmatter(design.md §4.2)。 */
const knowledgeEntryBaseSchema = z
  .object({
    id: kbIdSchema,
    title: z.string().min(1),
    type: entryTypeSchema,
    domain: z
      .string()
      .regex(
        /^[a-z0-9-]+$/,
        "domain は小文字英数字とハイフンのみ(knowledge/ 直下のディレクトリ名)",
      ),
    tags: z.array(z.string().min(1)).default([]),
    sources: sourcesSchema,
    people: z.array(z.string().min(1)).default([]),
    confidence: confidenceSchema,
    status: entryStatusSchema,
    supersedes: kbIdSchema.optional(),
    created: dateOnlySchema,
    last_verified: dateOnlySchema,
    // 省略時は type 別デフォルトを適用(下記 transform)。decision は null(鮮度確認対象外)。
    review_interval_days: z.number().int().positive().optional(),
    owner: z.string().min(1),
  })
  .strict();

export const knowledgeEntrySchema = knowledgeEntryBaseSchema.transform((e) => ({
  ...e,
  review_interval_days: e.review_interval_days ?? DEFAULT_REVIEW_INTERVAL_DAYS[e.type],
}));

export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;
