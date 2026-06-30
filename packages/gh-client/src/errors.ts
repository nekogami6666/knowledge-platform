/**
 * gh-client の統一エラー(design.md §7.1)。基底クラス + 型付き code + cause を持つ
 * (packages/kb-core/src/errors.ts・packages/llm/src/errors.ts と同じ流儀)。
 * 利用側は message ではなく code で分岐する。シークレットは message に入れない(§9.1)。
 */

export type GhClientErrorCode =
  | "AUTH" // 認証情報の欠落 / 不正(App trio も token も無い等)
  | "NOT_FOUND" // 対象リソース(ファイル/ref 等)が存在しない
  | "CONFLICT" // 楽観ロック衝突(file SHA 不一致など、CAS リトライ対象)
  | "API_ERROR"; // その他の GitHub API / ネットワーク失敗

/** packages/gh-client が投げる統一エラー。 */
export class GhClientError extends Error {
  readonly name = "GhClientError";
  readonly code: GhClientErrorCode;

  constructor(code: GhClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}
