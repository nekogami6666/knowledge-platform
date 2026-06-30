import { describe, expect, it } from "vitest";
import { normalizePrivateKey, resolveGhAuthFromEnv } from "./auth.js";
import { GhClientError } from "./errors.js";

const appEnv = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
  GITHUB_APP_INSTALLATION_ID: "456",
};

describe("resolveGhAuthFromEnv", () => {
  it("App trio が揃えば app(秘密鍵は正規化)", () => {
    const a = resolveGhAuthFromEnv(appEnv);
    expect(a.kind).toBe("app");
    if (a.kind === "app") {
      expect(a.appId).toBe("123");
      expect(a.installationId).toBe("456");
      // \n エスケープが実改行へ正規化される
      expect(a.privateKey).toContain("\n");
      expect(a.privateKey).not.toContain("\\n");
    }
  });

  it("token のみなら token", () => {
    expect(resolveGhAuthFromEnv({ GITHUB_TOKEN: "ghp_x" })).toEqual({
      kind: "token",
      token: "ghp_x",
    });
  });

  it("App trio と token 両方なら app 優先", () => {
    expect(resolveGhAuthFromEnv({ ...appEnv, GITHUB_TOKEN: "ghp_x" }).kind).toBe("app");
  });

  it("どちらも無ければ AUTH エラー(値は出さない)", () => {
    let err: unknown;
    try {
      resolveGhAuthFromEnv({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GhClientError);
    expect((err as GhClientError).code).toBe("AUTH");
  });

  it("App trio が部分的かつ token 無しは AUTH エラー", () => {
    expect(() => resolveGhAuthFromEnv({ GITHUB_APP_ID: "123" })).toThrow(GhClientError);
  });
});

describe("normalizePrivateKey", () => {
  it("PEM(\\n エスケープ)は実改行へ", () => {
    expect(normalizePrivateKey("-----BEGIN-----\\nx\\n-----END-----")).toBe(
      "-----BEGIN-----\nx\n-----END-----",
    );
  });

  it("base64 は PEM へデコード", () => {
    const pem = "-----BEGIN-----\nx\n-----END-----";
    const b64 = Buffer.from(pem, "utf8").toString("base64");
    expect(normalizePrivateKey(b64)).toBe(pem);
  });
});
