import { z } from "zod";

/**
 * メンバー対応表 `_meta/members.yaml`(ADR-0017 D3 / ADR-0021、KB が唯一の正)。純 YAML。
 * 人物識別子は GitHub ユーザ名が正(design.md §4.2)で、Discord ID への写像を各自が PR で申告する(§14#8)。
 * GitHub 未所持のメンバーは `github` を省略し Discord ID を識別子とする(ADR-0021 D1)。1 人が複数の
 * GitHub / Discord アカウントを持つ場合は primary=`github`/`discord` + `github_alts`/`discord_alts`(ADR-0021 D2)。
 * `name`(表示名・フルネーム)は人間向けサーフェス(expertise レポート・PR 本文等)の実名表示用の
 * 唯一の構造化供給源(ADR-0022)。解決キー(github/discord)とは別で、表示専用。
 * 議事録の発言者ラベル(speaker_labels)は v1 スコープ外 — 議事録 evidence コレクタを足す将来 PR で
 * スキーマ拡張とセットで導入する(ADR-0017 D2)。
 */
export const memberSchema = z
  .object({
    /** 表示名(フルネーム)。人間向け表示専用・任意(ADR-0022)。解決には使わない。 */
    name: z.string().min(1).optional(),
    /** GitHub ユーザ名(人物識別子の正)。GitHub 未所持のメンバーは省略可(ADR-0021 D1)。 */
    github: z.string().min(1).optional(),
    /** 追加の GitHub ユーザ名(1 人で複数アカウントを持つ場合の別名。primary=github・ADR-0021 D2)。 */
    github_alts: z.array(z.string().min(1)).nonempty().optional(),
    /** Discord ユーザ ID(snowflake)。全メンバー必須。DM 送信・逆引きの primary。 */
    discord: z.string().min(1),
    /** 追加の Discord ユーザ ID(1 人で複数 Discord アカウントを持つ場合の別名。primary=discord・ADR-0021 D2)。 */
    discord_alts: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict()
  .refine((m) => m.github !== undefined || m.github_alts === undefined, {
    message: "github_alts は primary の github が無いと指定できません(ADR-0021 D3)",
    path: ["github_alts"],
  });

export const membersSchema = z
  .object({
    members: z.array(memberSchema).default([]),
  })
  .strict();

export type Member = z.infer<typeof memberSchema>;
export type Members = z.infer<typeof membersSchema>;
