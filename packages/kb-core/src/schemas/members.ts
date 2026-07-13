import { z } from "zod";

/**
 * メンバー対応表 `_meta/members.yaml`(ADR-0017 D3、KB が唯一の正)。純 YAML。
 * 人物識別子は GitHub ユーザ名が正(design.md §4.2)で、Discord ID への写像を各自が PR で申告する(§14#8)。
 * 議事録の発言者ラベル(speaker_labels)は v1 スコープ外 — 議事録 evidence コレクタを足す将来 PR で
 * スキーマ拡張とセットで導入する(ADR-0017 D2)。
 */
export const memberSchema = z
  .object({
    /** GitHub ユーザ名(人物識別子の正)。 */
    github: z.string().min(1),
    /** Discord ユーザ ID(snowflake)。 */
    discord: z.string().min(1),
  })
  .strict();

export const membersSchema = z
  .object({
    members: z.array(memberSchema).default([]),
  })
  .strict();

export type Member = z.infer<typeof memberSchema>;
export type Members = z.infer<typeof membersSchema>;
