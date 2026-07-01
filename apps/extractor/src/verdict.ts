/**
 * 突合判定(reconcile)の中間スキーマ(design.md §6.3 step3)。中間型であり kb-core エントリではない。
 * 1 候補につき既存 KB との関係を **new / duplicate / contradiction** の1件に分類する(blast-radius-1)。
 * `.default()`/`.superRefine()` は使わず素の strict object(input==output で `z.ZodType<T>` と整合)。
 * duplicate/contradiction で target が欠けた場合は materialize 側で防御的に扱う。
 */
import { z } from "zod";

export const verdictSchema = z
  .object({
    classification: z.enum(["new", "duplicate", "contradiction"]),
    /** duplicate/contradiction のとき、既存エントリの repo 相対パス。 */
    targetPath: z.string().optional(),
    /** その既存エントリの id(kb-/dr-)。 */
    targetId: z.string().optional(),
    /** 判定理由(日本語・§8.2)。 */
    reason: z.string().min(1),
  })
  .strict();
export type Verdict = z.infer<typeof verdictSchema>;
