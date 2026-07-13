import type { z } from "zod";

/**
 * 「どのフィールドがなぜ不正か」を機械可読に表す単位。
 * zod の issue を path(ドット区切り)+ message + code に正規化する。
 */
export interface KbIssue {
  /** 不正なフィールドへのパス(例 "sources.0.url")。トップレベルは "(root)"。 */
  path: string;
  /** 人間可読の理由。 */
  message: string;
  /** zod の issue code(例 "invalid_type" / "invalid_enum_value")。 */
  code: string;
}

export function zodErrorToIssues(error: z.ZodError): KbIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

export type KbParseErrorCode = "MISSING_FRONTMATTER" | "INVALID_YAML" | "SCHEMA_VIOLATION";

/** parseEntry / validateRepo が frontmatter を読めない・スキーマ違反のときに投げる。 */
export class KbParseError extends Error {
  readonly name = "KbParseError";
  readonly code: KbParseErrorCode;
  /** 対象ファイルパス(分かる場合)。 */
  readonly file: string | undefined;
  /** スキーマ違反(SCHEMA_VIOLATION)時のフィールド単位の所見。 */
  readonly issues: KbIssue[];

  constructor(
    code: KbParseErrorCode,
    message: string,
    options?: { file?: string; issues?: KbIssue[]; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.file = options?.file;
    this.issues = options?.issues ?? [];
  }
}

/** allocateId の採番失敗(競合上限到達・4 桁溢れ・カウンタ破損)。 */
export class KbIdError extends Error {
  readonly name = "KbIdError";
  readonly code: "OVERFLOW" | "CONFLICT" | "CORRUPT_COUNTER";

  constructor(
    code: "OVERFLOW" | "CONFLICT" | "CORRUPT_COUNTER",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

/** provenance ヘルパが不正・許可外ドメインの URL/source を扱ったときに投げる。 */
export class KbProvenanceError extends Error {
  readonly name = "KbProvenanceError";
}
