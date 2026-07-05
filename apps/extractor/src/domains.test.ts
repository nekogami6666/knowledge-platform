import { describe, expect, it } from "vitest";
import { checkDomainProximity, listDomains, type ReaddirFn } from "./domains.js";

const dirents = (names: string[]): { name: string; isDirectory(): boolean }[] =>
  names.map((name) => ({ name, isDirectory: () => true }));

describe("listDomains", () => {
  it("knowledge/ 直下のディレクトリ名を返す(先頭 _/. とファイルは除外・ソート)", async () => {
    const readdir: ReaddirFn = async () => [
      ...dirents(["hardware", "firmware"]),
      { name: "_templates", isDirectory: () => true },
      { name: ".git", isDirectory: () => true },
      { name: "readme.md", isDirectory: () => false },
    ];
    expect(await listDomains("/kb", readdir)).toEqual(["firmware", "hardware"]);
  });
  it("knowledge/ が無ければ空(readdir の throw を吸収)", async () => {
    const readdir: ReaddirFn = async () => {
      throw new Error("ENOENT");
    };
    expect(await listDomains("/kb", readdir)).toEqual([]);
  });
});

describe("checkDomainProximity", () => {
  it("包含する既存名を近接として返す(hardware-verification ⊃ hardware)", () => {
    expect(checkDomainProximity("hardware-verification", ["hardware", "robotics"])).toBe(
      "hardware",
    );
  });
  it("無関係は null(robotics は hardware/firmware に近接しない)", () => {
    expect(checkDomainProximity("robotics", ["hardware", "firmware"])).toBeNull();
  });
  it("完全一致(再利用)は近接ではない=null", () => {
    expect(checkDomainProximity("hardware", ["hardware"])).toBeNull();
  });
  it("短すぎる部分文字列は誤検出しない(ai ⊄ email)", () => {
    expect(checkDomainProximity("ai", ["email"])).toBeNull();
  });
});
