import { z } from "zod";
import {
  botAnswerQualitySchema,
  isoDateTimeSchema,
  kbIdSchema,
  qIdSchema,
  questionStatusSchema,
} from "./common.js";

/** 質問ログの frontmatter(design.md §4.4)。sources は持たない(出典は本文の記録)。 */
export const questionLogSchema = z
  .object({
    id: qIdSchema,
    asked_by: z.string().min(1),
    asked_at: isoDateTimeSchema,
    channel: z.string().min(1),
    question: z.string().min(1),
    bot_answer_quality: botAnswerQualitySchema,
    assignee: z.string().min(1).optional(),
    status: questionStatusSchema,
    resulting_kb: kbIdSchema.optional(),
  })
  .strict();

export type QuestionLog = z.infer<typeof questionLogSchema>;
