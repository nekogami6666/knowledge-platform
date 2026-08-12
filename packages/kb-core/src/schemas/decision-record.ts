import { z } from "zod";
import { dateOnlySchema, drIdSchema, drStatusSchema } from "./common.js";
import { sourcesSchema } from "./source.js";

/** Decision Record の frontmatter(design.md §4.3)。 */
export const decisionRecordSchema = z
  .object({
    id: drIdSchema,
    title: z.string().min(1),
    date: dateOnlySchema,
    status: drStatusSchema,
    // 置き換えた旧決定の追跡(ADR-0027 D4・v5。ADR-0026 D8「DR に supersedes 無し」の見直し)。
    supersedes: drIdSchema.optional(),
    deciders: z.array(z.string().min(1)).min(1, "deciders は 1 件以上必須です"),
    sources: sourcesSchema,
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
