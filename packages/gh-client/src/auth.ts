/**
 * GitHub 認証(design.md §9.1 / ADR-0004 / ADR-0011)。
 * 本番は GitHub App、認証未整備の間は token(PAT / Actions GITHUB_TOKEN)を暫定で許す auth-agnostic。
 * 実 Octokit 生成はここ(seam の外)に隔離し、client.ts は注入された OctokitLike だけに依存する。
 * シークレット値はエラーメッセージ・ログに出さない(§9.1)。
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { z } from "zod";
import { GhClientError } from "./errors.js";

/** GitHub 認証情報。App(本番)か token(暫定)。 */
export type GhAuth =
  | { kind: "app"; appId: string; privateKey: string; installationId: string }
  | { kind: "token"; token: string };

const envSchema = z.object({
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
});

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * PEM(改行 or `\n` エスケープ)または base64 の秘密鍵を PEM 文字列へ正規化する。
 * env では改行が `\n` リテラルや base64 で渡されることが多いため両対応する。
 */
export function normalizePrivateKey(raw: string): string {
  if (raw.includes("-----BEGIN")) return raw.replaceAll("\\n", "\n");
  return Buffer.from(raw, "base64").toString("utf8");
}

/**
 * env から {@link GhAuth} を解決する。App trio(ID/秘密鍵/installation)が揃えば app、
 * 無ければ `GITHUB_TOKEN` で token、どちらも無ければ `GhClientError("AUTH")`。
 * 値そのものはエラーに含めない(§9.1)。
 */
export function resolveGhAuthFromEnv(
  source: Record<string, string | undefined> = process.env,
): GhAuth {
  const env = envSchema.parse(source);
  if (
    nonEmpty(env.GITHUB_APP_ID) &&
    nonEmpty(env.GITHUB_APP_PRIVATE_KEY) &&
    nonEmpty(env.GITHUB_APP_INSTALLATION_ID)
  ) {
    return {
      kind: "app",
      appId: env.GITHUB_APP_ID,
      privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    };
  }
  if (nonEmpty(env.GITHUB_TOKEN)) {
    return { kind: "token", token: env.GITHUB_TOKEN };
  }
  throw new GhClientError(
    "AUTH",
    "GitHub 認証がありません。App(GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID)か GITHUB_TOKEN を設定してください。",
  );
}

/** {@link GhAuth} から認証済み Octokit を生成する(実 SDK。seam の外)。 */
export function createOctokit(auth: GhAuth): Octokit {
  if (auth.kind === "app") {
    // appId / installationId は数値 ID(@octokit/auth-app の型に合わせ Number 化)。
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: Number(auth.appId),
        privateKey: auth.privateKey,
        installationId: Number(auth.installationId),
      },
    });
  }
  return new Octokit({ auth: auth.token });
}
