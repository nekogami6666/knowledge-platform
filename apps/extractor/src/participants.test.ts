import type { Member } from "@stratum/kb-core";
import { describe, expect, it } from "vitest";
import { buildNameResolver, parseParticipants } from "./participants.js";

const EXCLUDE = ["QB", "Recorder"];

describe("parseParticipants(ADR-0027 D1)", () => {
  it("空白で氏名を分割せず、bot・記号を除外する(ADR 検証1)", () => {
    const content =
      "# 会議\n参加者: Shoma Nagata / kanto ide / QB Recorder / Pascal Pama (Paco)\n本文";
    expect(parseParticipants(content, { exclude: EXCLUDE })).toEqual([
      "Shoma Nagata",
      "kanto ide",
      "Pascal Pama",
    ]);
  });

  it("`,`・`、`・`/` のみで分割する(氏名内の空白は保持)", () => {
    const content = "参加者: 山田 太郎、Suzuki Jiro, sato/ tanaka";
    expect(parseParticipants(content)).toEqual(["山田 太郎", "Suzuki Jiro", "sato", "tanaka"]);
  });

  it("数字のみ・記号のみ・1文字・空トークンを除外する", () => {
    const content = "参加者: 02, /, -, x, , yamada";
    expect(parseParticipants(content)).toEqual(["yamada"]);
  });

  it("括弧注記(半角・全角)を除去して本体名を採る", () => {
    const content = "参加者: Pascal Pama (Paco), 山田 太郎(やまだ)";
    expect(parseParticipants(content)).toEqual(["Pascal Pama", "山田 太郎"]);
  });

  it("注記だけのトークン((Paco) 単独)は除外される", () => {
    const content = "参加者: (Paco), yamada";
    expect(parseParticipants(content)).toEqual(["yamada"]);
  });

  it("exclude は大文字小文字を無視して完全一致で除外する", () => {
    const content = "参加者: qb, recorder, yamada";
    expect(parseParticipants(content, { exclude: EXCLUDE })).toEqual(["yamada"]);
  });

  it("resolve が解決した名前は正規化(GitHub 名)、解決できない名前は生のまま保持する", () => {
    const members: Member[] = [
      { name: "Shoma Nagata", github: "shoma", discord: "1" },
      { name: "Kanto Ide", github: "kanto", github_alts: ["kanto-sub"], discord: "2" },
    ];
    const resolve = buildNameResolver(members);
    const content = "参加者: Shoma Nagata / kanto ide / QB Recorder / Pascal Pama (Paco)";
    expect(parseParticipants(content, { exclude: EXCLUDE, resolve })).toEqual([
      "shoma", // "Shoma Nagata"(name)と一致 → github 名へ正規化
      "kanto", // "kanto ide" は "Kanto Ide"(name)と大小無視で一致 → github 名へ正規化
      "Pascal Pama", // members に無い外部出席者 → 生名保持
    ]);
  });

  it("参加者行が無ければ空配列", () => {
    expect(parseParticipants("# 会議\n本文のみ")).toEqual([]);
  });

  it("重複は 1 件に畳む(正規化後の名前で判定)", () => {
    const members: Member[] = [{ name: "Yamada Taro", github: "yamada", discord: "1" }];
    const resolve = buildNameResolver(members);
    const content = "参加者: yamada, Yamada Taro";
    expect(parseParticipants(content, { resolve })).toEqual(["yamada"]);
  });
});

describe("buildNameResolver(members.yaml 照合・§4.2)", () => {
  const members: Member[] = [
    { name: "Shoma Nagata", github: "shoma", github_alts: ["shoma-alt"], discord: "1" },
    { name: "外部 太郎", discord: "2" }, // github 無し(ADR-0021 D1)
  ];
  const resolve = buildNameResolver(members);

  it("name / github / github_alts と大小無視・trim 一致で github 名を返す", () => {
    expect(resolve("shoma nagata")).toBe("shoma");
    expect(resolve(" SHOMA ")).toBe("shoma");
    expect(resolve("Shoma-Alt")).toBe("shoma");
  });

  it("github の無い member は null(呼び出し側が生名を保持する)", () => {
    expect(resolve("外部 太郎")).toBeNull();
  });

  it("未登載の名前は null", () => {
    expect(resolve("unknown person")).toBeNull();
  });
});
