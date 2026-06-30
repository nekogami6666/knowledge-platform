/**
 * @stratum/gh-client — GitHub 認証 + Octokit ラッパ + PR ヘルパ(design.md §3.2 L3 / §6 / §9.1)。
 * バッチ群(extractor / gap-tracker 等)が knowledge-base に PR を書くための共通土台。
 * 認証は App / token 両対応(ADR-0004 / ADR-0011)。Octokit は注入 seam の背後に隔離する。
 */

// --- 認証 ---
export { createOctokit, type GhAuth, normalizePrivateKey, resolveGhAuthFromEnv } from "./auth.js";
// --- クライアント ---
export {
  type CreatePrOptions,
  createGhClient,
  createGhClientFromAuth,
  createGhClientFromEnv,
  type FileChange,
  type GetFileOptions,
  type GhClient,
  type ListPrOptions,
  type MergePrOptions,
  type OctokitLike,
  type PrSummary,
  splitRepo,
} from "./client.js";
// --- エラー ---
export { GhClientError, type GhClientErrorCode } from "./errors.js";
