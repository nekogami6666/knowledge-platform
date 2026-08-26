/**
 * clone/fetch 認証の実行時注入(#139 セキュリティ修正)。トークンは env(GIT_CLONE_TOKEN)から
 * URL へ合成し、**config ファイルに平文で置かない**。/config は /ask エージェント(Read)から
 * 可視で、実際に読まれた実績がある(§9.1)。既に認証入りの URL はそのまま返す(後方互換 —
 * 呼び出し側が warn で env への移行を促す)。
 * 3 app の複製(discord-bot repos.ts / gap-tracker config.ts / freshness-checker config.ts)を
 * ここへ統合した(§2-F 方針・ADR-0033 B1)。
 */
export function withCloneToken(url: string, token: string | undefined): string {
  if (token === undefined || token.length === 0) return url;
  if (/^https:\/\/[^@/]+@/.test(url)) return url; // 既に認証あり(移行前の構成)
  return url.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}
