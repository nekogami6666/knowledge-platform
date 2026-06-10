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
    deciders: z.array(z.string().min(1)).min(1, "deciders は 1 件以上必須です"),
    sources: sourcesSchema,
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
