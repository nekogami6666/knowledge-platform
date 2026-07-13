import { describe, expect, it } from "vitest";
import { KbParseError } from "./errors.js";
import { discordForGithub, githubForDiscord, parseMembers } from "./members-io.js";

const VALID = `members:
  - github: yamada
    discord: "123456789012345678"
  - github: suzuki
    discord: "234567890123456789"
`;

describe("parseMembers", () => {
  it("正常系: github ↔ discord の配列を返す", () => {
    const m = parseMembers(VALID);
    expect(m.members).toHaveLength(2);
    expect(m.members[0]).toEqual({ github: "yamada", discord: "123456789012345678" });
  });

  it("空ファイル・members 省略は空配列(§14#8 未決の間は空で可)", () => {
    expect(parseMembers("").members).toEqual([]);
    expect(parseMembers("members: []").members).toEqual([]);
  });

  it("YAML 構文エラーは INVALID_YAML", () => {
    try {
      parseMembers("members:\n\t- github: : :\n");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KbParseError);
      expect((e as KbParseError).code).toBe("INVALID_YAML");
    }
  });

  it("スキーマ違反(未知フィールド・discord 欠落)は SCHEMA_VIOLATION + issue パス", () => {
    try {
      parseMembers("members:\n  - github: yamada\n    slack: U01\n");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KbParseError);
      const err = e as KbParseError;
      expect(err.code).toBe("SCHEMA_VIOLATION");
      expect(err.issues.length).toBeGreaterThan(0);
    }
  });

  it("discord の数値(クォート無し)はスキーマ違反(文字列必須)", () => {
    expect(() => parseMembers("members:\n  - github: yamada\n    discord: 123\n")).toThrow(
      KbParseError,
    );
  });
});

describe("githubForDiscord / discordForGithub", () => {
  const m = parseMembers(VALID);
  it("双方向に引ける・未登載は undefined", () => {
    expect(githubForDiscord(m, "123456789012345678")).toBe("yamada");
    expect(githubForDiscord(m, "999")).toBeUndefined();
    expect(discordForGithub(m, "suzuki")).toBe("234567890123456789");
    expect(discordForGithub(m, "unknown")).toBeUndefined();
  });
});
