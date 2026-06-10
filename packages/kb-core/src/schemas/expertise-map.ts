import { z } from "zod";
import { dateOnlySchema, isoDateTimeSchema, riskSchema } from "./common.js";

/** 専門性マップ expertise.yaml(design.md §4.5、自動生成・手編集禁止)。純 YAML。 */
export const expertisePersonSchema = z
  .object({
    name: z.string().min(1),
    evidence_count: z.number().int().nonnegative(),
    last_active: dateOnlySchema,
  })
  .strict();

export const expertiseTopicSchema = z
  .object({
    topic: z.string().min(1),
    label: z.string().min(1),
    people: z.array(expertisePersonSchema).min(1, "topic.people は 1 件以上必須です"),
    bus_factor: z.number().int().positive(),
    documented_kb_count: z.number().int().nonnegative(),
    risk: riskSchema,
  })
  .strict();

export const expertiseMapSchema = z
  .object({
    generated_at: isoDateTimeSchema,
    topics: z.array(expertiseTopicSchema),
  })
  .strict();

export type ExpertisePerson = z.infer<typeof expertisePersonSchema>;
export type ExpertiseTopic = z.infer<typeof expertiseTopicSchema>;
export type ExpertiseMap = z.infer<typeof expertiseMapSchema>;
