/**
 * `_meta/members.yaml` の読み取り(ADR-0017 D3)。純 YAML + zod(entry-io の frontmatter とは別系統)。
 * 書き手は人間(各自の申告 PR)なので、壊れた入力は KbParseError で「どこがなぜ不正か」を返す。
 * consumer(discord-bot / expertise-mapper)は失敗を「空の対応表 + 警告」に落として続行してよい
 * (owner は "unassigned" フォールバック)。
 */
import { JSON_SCHEMA, load as yamlLoad } from "js-yaml";
import { KbParseError, zodErrorToIssues } from "./errors.js";
import { type Members, membersSchema } from "./schemas/members.js";

/** members.yaml の全文を parse する。空ファイルは `{ members: [] }`。失敗は KbParseError。 */
export function parseMembers(raw: string, file?: string): Members {
  let data: unknown;
  try {
    // JSON_SCHEMA: YAML の暗黙型変換(タイムスタンプ等)を避ける(entry-io / validate-repo と同じ流儀)。
    data = yamlLoad(raw, { schema: JSON_SCHEMA });
  } catch (cause) {
    throw new KbParseError("INVALID_YAML", "members.yaml の YAML 構文が不正です", { file, cause });
  }
  const result = membersSchema.safeParse(data ?? {});
  if (!result.success) {
    throw new KbParseError("SCHEMA_VIOLATION", "members.yaml がスキーマに違反しています", {
      file,
      issues: zodErrorToIssues(result.error),
    });
  }
  return result.data;
}

/** Discord ユーザ ID → GitHub ユーザ名(primary/別名のどちらでも一致・ADR-0021 D2。未登載は undefined)。 */
export function githubForDiscord(members: Members, discordId: string): string | undefined {
  return members.members.find(
    (m) => m.discord === discordId || (m.discord_alts?.includes(discordId) ?? false),
  )?.github;
}

/** GitHub ユーザ名 → Discord ユーザ ID(primary/別名のどちらでも一致・ADR-0021 D2。未登載は undefined)。 */
export function discordForGithub(members: Members, github: string): string | undefined {
  return members.members.find(
    (m) => m.github === github || (m.github_alts?.includes(github) ?? false),
  )?.discord;
}
