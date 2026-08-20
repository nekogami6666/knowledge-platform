import { describe, expect, it } from "vitest";
import { withCloneToken } from "./config.js";

describe("withCloneToken(clone 認証の実行時注入・㉞)", () => {
  it("トークンを https URL へ注入する", () => {
    expect(withCloneToken("https://github.com/o/r.git", "tok123")).toBe(
      "https://x-access-token:tok123@github.com/o/r.git",
    );
  });
  it("既に認証入りの URL・トークン未設定はそのまま(後方互換)", () => {
    expect(withCloneToken("https://x:old@github.com/o/r.git", "tok123")).toBe(
      "https://x:old@github.com/o/r.git",
    );
    expect(withCloneToken("https://github.com/o/r.git", undefined)).toBe(
      "https://github.com/o/r.git",
    );
  });
});
