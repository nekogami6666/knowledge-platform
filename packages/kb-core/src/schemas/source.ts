import { z } from "zod";

/**
 * provenance: ナレッジの出典(design.md §4.2 / P2)。
 *
 * §4.2 は meeting(repo/path/lines)と discord(url)のみ例示している。残り 4 種の形状は
 * /component 起票時に「種別ごとに最適化」する方針で確定した(PR 本文の論点 D-5 参照):
 *   - meeting / voice-memo / interview: ファイル参照 {repo, path, lines?, ref?}
 *   - pr / issue:                       {repo, number, ref?}
 *   - discord:                          {url}
 *
 * `ref` は真の permalink 生成(commit SHA 固定)のための任意フィールド(論点 D-6)。
 */

/** "org/repo" 形式のリポジトリ参照。 */
export const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "repo は 'org/name' 形式である必要があります");

/** "L120" または "L120-L141"。範囲指定は start <= end。 */
export const LINE_RANGE_RE = /^L(\d+)(?:-L(\d+))?$/;
export const lineRangeSchema = z
  .string()
  .regex(LINE_RANGE_RE, 'lines は "L120" または "L120-L141" 形式である必要があります')
  .refine((s) => {
    const m = LINE_RANGE_RE.exec(s);
    if (!m) return false;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    return start >= 1 && end >= start;
  }, "lines の範囲が不正です(開始 >= 1 かつ 開始 <= 終了)");

/** Discord メッセージ permalink。 */
export const DISCORD_PERMALINK_RE = /^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/;
export const discordUrlSchema = z
  .string()
  .regex(
    DISCORD_PERMALINK_RE,
    "discord の url は https://discord.com/channels/<guild>/<channel>/<message> 形式である必要があります",
  );

const fileSourceShape = {
  repo: repoSchema,
  path: z.string().min(1),
  lines: lineRangeSchema.optional(),
  ref: z.string().min(1).optional(),
};

// pr / issue の URL(/pull/N ・ /issues/N)はそれ自体が permalink のため ref を持たない。
const refSourceShape = {
  repo: repoSchema,
  number: z.number().int().positive(),
};

export const meetingSourceSchema = z
  .object({ kind: z.literal("meeting"), ...fileSourceShape })
  .strict();
export const voiceMemoSourceSchema = z
  .object({ kind: z.literal("voice-memo"), ...fileSourceShape })
  .strict();
export const interviewSourceSchema = z
  .object({ kind: z.literal("interview"), ...fileSourceShape })
  .strict();
export const prSourceSchema = z.object({ kind: z.literal("pr"), ...refSourceShape }).strict();
export const issueSourceSchema = z.object({ kind: z.literal("issue"), ...refSourceShape }).strict();
export const discordSourceSchema = z
  .object({ kind: z.literal("discord"), url: discordUrlSchema })
  .strict();

export const sourceSchema = z.discriminatedUnion("kind", [
  meetingSourceSchema,
  voiceMemoSourceSchema,
  interviewSourceSchema,
  prSourceSchema,
  issueSourceSchema,
  discordSourceSchema,
]);
export type Source = z.infer<typeof sourceSchema>;

/** P2: sources は 1 件以上必須。 */
export const sourcesSchema = z
  .array(sourceSchema)
  .min(1, "sources は 1 件以上必須です(P2: 出典のない知識は存在しない)");
