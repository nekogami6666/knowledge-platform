/**
 * 鮮度確認(design.md §6.7 / ADR-0019)の pending_actions 契約。
 * 書き手は freshness-checker(VM systemd timer・期限超過エントリを積む)、読み手は bot
 * (DM + 👍✏️🗑 リアクション UI)。app 間で型を再定義しない(§12.2)ため、
 * pending_actions の所有者である discord-bot がこの契約を持つ(ADR-0014 D2 と同じ所有権)。
 */
import { z } from "zod";

/** PendingAction.type の値(db.ts の例示と一致)。 */
export const FRESHNESS_ACTION_TYPE = "freshness";

export const freshnessPayloadSchema = z
  .object({
    /** 対象エントリの id(kb-YYYY-NNNN)。 */
    entryId: z.string().min(1),
    /** KB リポ相対パス(knowledge/<domain>/<id>.md)。👍/🗑 の commit と ✏️ の PR が使う。 */
    path: z.string().min(1),
    /** DM 本文に載せる表題。 */
    title: z.string().min(1),
    /** frontmatter の owner(GitHub ユーザ名)。 */
    ownerGithub: z.string().min(1),
    /** DM 送信先(checker が _meta/members.yaml で解決済み・ADR-0017 D3)。 */
    ownerDiscord: z.string().min(1),
    /** 積んだ時点の last_verified(👍 更新時の楽観ロック代わりの参考値)。 */
    lastVerified: z.string().min(1),
  })
  .strict();
export type FreshnessPayload = z.infer<typeof freshnessPayloadSchema>;

/** payloadJson を検証付きで parse する。壊れていれば null(呼び手が warn してスキップ)。 */
export function parseFreshnessPayload(json: string | null): FreshnessPayload | null {
  if (json === null) return null;
  try {
    return freshnessPayloadSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}
