import { describe, expect, it } from "vitest";
import { KbParseError } from "./errors.js";
import { discordForGithub, githubForDiscord, parseMembers } from "./members-io.js";

const VALID = `members:
  - github: yamada
    discord: "123456789012345678"
  - github: suzuki
    discord: "234567890123456789"
`;

// ADR-0021 拡張: github 省略(未所持)+ github_alts / discord_alts(複数アカウント)。
const VALID_EXT = `members:
  - discord: "111111111111111111"
  - github: kazu-nemoto
    github_alts: [nimotougou]
    discord: "222222222222222222"
  - github: multi-discord-user
    discord: "333333333333333333"
    discord_alts: ["444444444444444444"]
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

describe("parseMembers (ADR-0021 拡張)", () => {
  it("github 省略(GitHub 未所持・discord のみ)を許容する", () => {
    const m = parseMembers(VALID_EXT);
    expect(m.members[0]).toEqual({ discord: "111111111111111111" });
    expect(m.members[0]?.github).toBeUndefined();
  });

  it("github_alts(複数アカウント)を parse する", () => {
    const m = parseMembers(VALID_EXT);
    expect(m.members[1]).toEqual({
      github: "kazu-nemoto",
      github_alts: ["nimotougou"],
      discord: "222222222222222222",
    });
  });

  it("discord_alts(複数 Discord アカウント)を parse する", () => {
    const m = parseMembers(VALID_EXT);
    expect(m.members[2]).toEqual({
      github: "multi-discord-user",
      discord: "333333333333333333",
      discord_alts: ["444444444444444444"],
    });
  });

  it("github_alts だけで primary github が無いのは SCHEMA_VIOLATION(ADR-0021 D3)", () => {
    try {
      parseMembers('members:\n  - github_alts: [x]\n    discord: "1"\n');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KbParseError);
      expect((e as KbParseError).code).toBe("SCHEMA_VIOLATION");
    }
  });

  it("空の github_alts は不可(nonempty)", () => {
    expect(() =>
      parseMembers('members:\n  - github: a\n    github_alts: []\n    discord: "1"\n'),
    ).toThrow(KbParseError);
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

  it("discordForGithub は github_alts(別名)でも本人へ解決する(ADR-0021 D2)", () => {
    const mm = parseMembers(VALID_EXT);
    expect(discordForGithub(mm, "kazu-nemoto")).toBe("222222222222222222"); // primary
    expect(discordForGithub(mm, "nimotougou")).toBe("222222222222222222"); // 別名
    expect(githubForDiscord(mm, "111111111111111111")).toBeUndefined(); // github 未所持
  });

  it("githubForDiscord は discord_alts(別名 Discord)でも本人へ解決する(ADR-0021 D2)", () => {
    const mm = parseMembers(VALID_EXT);
    expect(githubForDiscord(mm, "333333333333333333")).toBe("multi-discord-user"); // primary
    expect(githubForDiscord(mm, "444444444444444444")).toBe("multi-discord-user"); // 別名
  });
});
