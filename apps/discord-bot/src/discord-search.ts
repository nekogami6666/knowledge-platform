/**
 * Discord 本文検索(ADR-0038)の公開バレル(`@stratum/discord-bot/discord-search` サブパス)。
 * golden eval が実 Discord なしで「保存 → 質問者の範囲で検索 → 引用検証」の経路を fixture で検証するために使う。
 * 実装の正はそれぞれのモジュール(ここは再 export のみ)。better-sqlite3 を読み込むため、利用側は native の
 * 有無を確かめてから動的 import すること。
 */
export {
  createDiscordIndexStore,
  type DiscordIndexStore,
  type IndexedChannel,
  type IndexedMessage,
} from "./discord-index-store.js";
export {
  createDiscordIndexSync,
  type DiscordIndexSource,
  type SourceChannel,
  type SourceMessage,
} from "./discord-index-sync.js";
export {
  computeChannelPermissions,
  computeSearchScope,
  type DiscordSearchScope,
  type PermChannel,
  type PermGuild,
  type PermMember,
} from "./discord-search-scope.js";
export {
  createDiscordSearchSession,
  type DiscordSearchSession,
} from "./discord-search-tool.js";
