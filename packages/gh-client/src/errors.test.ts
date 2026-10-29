import { describe, expect, it } from "vitest";
import { GhClientError } from "./errors.js";

describe("GhClientError", () => {
  it("原因に HTTP status があれば message 末尾に付ける", () => {
    const cause = Object.assign(new Error("Server Error"), { status: 502 });
    const e = new GhClientError("API_ERROR", "PR 一覧の取得に失敗しました(o/r)", { cause });
    expect(e.message).toBe("PR 一覧の取得に失敗しました(o/r)(HTTP 502)");
    expect(e.cause).toBe(cause);
  });

  it("status が無ければ message は変えない", () => {
    expect(new GhClientError("AUTH", "認証情報がありません").message).toBe("認証情報がありません");
    const e = new GhClientError("API_ERROR", "x", { cause: new Error("ECONNRESET") });
    expect(e.message).toBe("x");
  });
});
