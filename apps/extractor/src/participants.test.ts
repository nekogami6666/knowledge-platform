import type { Member } from "@stratum/kb-core";
import { describe, expect, it } from "vitest";
import { buildNameResolver, parseParticipants, resolvePeople } from "./participants.js";

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

  it("github の無い member は name を正規名として返す(ADR-0031 D2)", () => {
    // 旧挙動は null(= 生名保持)だったが、members に載っている人は必ず正規名に揃える。
    expect(resolve("外部 太郎")).toBe("外部 太郎");
  });

  it("未登載の名前は null", () => {
    expect(resolve("unknown person")).toBeNull();
  });
});

describe("buildNameResolver(aliases・一意トークン・ADR-0031)", () => {
  const members: Member[] = [
    { name: "Yoshimasa Muneishi", github: "yoshimuneco", aliases: ["宗石"], discord: "1" },
    { name: "Haruto Matsumoto", aliases: ["松本"], discord: "2" }, // github 無し
    { name: "Shoma Nagata", github: "shoma", discord: "3" },
    { name: "Kiei Nagai", discord: "4" },
    { name: "Yoshikawa Hiroshi", github: "banana", discord: "5" }, // 姓が先頭
  ];
  const resolve = buildNameResolver(members);

  it("aliases(漢字姓)で解決する。github 無しは name へ(D1/D2)", () => {
    expect(resolve("宗石")).toBe("yoshimuneco");
    expect(resolve("松本")).toBe("Haruto Matsumoto");
  });

  it("name の一意トークンで解決する(「Nagata」→ 本人)(D5)", () => {
    expect(resolve("Nagata")).toBe("shoma");
    expect(resolve("Muneishi")).toBe("yoshimuneco");
  });

  it("複数メンバーで衝突するトークンは解決しない(生名保持で安全側)", () => {
    // Nagata と Nagai は別トークンなので衝突しないが、前方一致はしない(完全一致のみ)。
    expect(resolve("Naga")).toBeNull();
    // 同一トークンが 2 人に現れたら無効化される。
    const dup = buildNameResolver([
      { name: "Sato Ichiro", github: "ichiro", discord: "1" },
      { name: "Sato Jiro", github: "jiro", discord: "2" },
    ]);
    expect(dup("Sato")).toBeNull(); // 衝突 → 解決しない
    expect(dup("Ichiro")).toBe("ichiro"); // 一意側は解決する
  });

  it("姓の位置(先頭/末尾)に依存しない(Yoshikawa Hiroshi でも姓で引ける)", () => {
    expect(resolve("Yoshikawa")).toBe("banana");
    expect(resolve("Hiroshi")).toBe("banana");
  });
});

describe("resolvePeople(LLM 出力の正規化・ADR-0031 D3)", () => {
  const members: Member[] = [
    { name: "Yoshimasa Muneishi", github: "yoshimuneco", aliases: ["宗石"], discord: "1" },
  ];
  const resolve = buildNameResolver(members);

  it("解決できれば正規名・できなければ生名保持、正規化後の重複は畳む", () => {
    expect(resolvePeople(["宗石", "Yoshimasa Muneishi", "外部ゲスト"], resolve)).toEqual([
      "yoshimuneco",
      "外部ゲスト",
    ]);
  });

  it("resolver 未提供(members.yaml 欠落)は素通し", () => {
    expect(resolvePeople(["宗石"], undefined)).toEqual(["宗石"]);
  });
});
