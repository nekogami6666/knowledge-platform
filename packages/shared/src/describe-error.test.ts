import { describe, expect, it } from "vitest";
import { describeError, maskSecrets } from "./describe-error.js";

describe("describeError", () => {
  it("cause をたどり HTTP status・リクエスト・API のメッセージを出す", () => {
    const http = Object.assign(new Error("Server Error"), {
      name: "HttpError",
      status: 502,
      request: {
        method: "GET",
        url: "https://api.github.com/repos/o/r/pulls?state=open&per_page=100",
      },
      response: { data: { message: "Server Error" } },
    });
    const wrapped = Object.assign(new Error("PR 一覧の取得に失敗しました(o/r)", { cause: http }), {
      name: "GhClientError",
      code: "API_ERROR",
    });
    expect(describeError(wrapped)).toBe(
      "GhClientError API_ERROR: PR 一覧の取得に失敗しました(o/r) ← HttpError HTTP 502 GET https://api.github.com/repos/o/r/pulls: Server Error",
    );
  });

  it("Node のシステムエラーは code・syscall・errno を出す", () => {
    const sys = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
      errno: -104,
    });
    const fetchErr = new TypeError("fetch failed", { cause: sys });
    expect(describeError(fetchErr)).toBe(
      "TypeError: fetch failed ← Error ECONNRESET syscall=read errno=-104: read ECONNRESET",
    );
  });

  it("同じ説明が続く段は 1 回だけ出す・循環で止まる", () => {
    const a = new Error("x");
    const b = new Error("x", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(describeError(b)).toBe("Error: x");
  });

  it("Error 以外も文字列にする", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("URL の資格情報とトークンを伏せる", () => {
    const e = new Error(
      "git clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git failed ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    );
    const out = describeError(e);
    expect(out).not.toContain("ghs_abcdef");
    expect(out).not.toContain("ghp_ABCDEF");
    expect(out).toContain("https://***@github.com/o/r.git");
  });

  it("request.url の資格情報とクエリを除く", () => {
    const e = Object.assign(new Error("Not Found"), {
      status: 404,
      request: { method: "GET", url: "https://u:p@api.github.com/x?token=secret" },
    });
    expect(describeError(e)).toBe("Error HTTP 404 GET https://api.github.com/x: Not Found");
  });
});

describe("maskSecrets", () => {
  it("Claude on AWS のキーらしき文字列を伏せる", () => {
    expect(maskSecrets("key=AEAAabcdefghijklmnopqrstuvwxyz")).toBe("key=AEAA***");
  });
});
