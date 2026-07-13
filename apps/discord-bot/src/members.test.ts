import { describe, expect, it, vi } from "vitest";
import { createCloneMembersLoader, DEFAULT_KB_DIR, EMPTY_MEMBERS } from "./members.js";

function makeLogger(): { warn: ReturnType<typeof vi.fn>; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const warn = vi.fn((...args: unknown[]) => {
    warns.push(args);
  });
  return { warn, warns };
}

describe("createCloneMembersLoader(ADR-0017 D3: KB clone の _meta/members.yaml を都度読み)", () => {
  const VALID = 'members:\n  - github: yamada\n    discord: "123456789012345678"\n';

  it("KB clone のパス(CLONES_DIR/<kbDir>/_meta/members.yaml)を読む", async () => {
    let readPath = "";
    const logger = makeLogger();
    const load = createCloneMembersLoader({
      clonesDir: "/clones",
      kbDir: DEFAULT_KB_DIR,
      logger,
      readFile: async (p) => {
        readPath = p;
        return VALID;
      },
    });
    const m = await load();
    expect(readPath).toBe("/clones/knowledge-base/_meta/members.yaml");
    expect(m.members[0]?.github).toBe("yamada");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("読めない(clone 未取得・未申告)は空の対応表 + 警告で続行", async () => {
    const logger = makeLogger();
    const load = createCloneMembersLoader({
      clonesDir: "/clones",
      kbDir: "kb",
      logger,
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await load()).toEqual(EMPTY_MEMBERS);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("parse 失敗(スキーマ違反)も空の対応表 + 警告で続行(bot を落とさない)", async () => {
    const logger = makeLogger();
    const load = createCloneMembersLoader({
      clonesDir: "/clones",
      kbDir: "kb",
      logger,
      readFile: async () => "members:\n  - github: yamada\n    slack: U01\n",
    });
    expect(await load()).toEqual(EMPTY_MEMBERS);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("都度読み: 呼ぶたびに読み直す(KB 申告が再起動なしで反映される)", async () => {
    const logger = makeLogger();
    let raw = "members: []";
    const load = createCloneMembersLoader({
      clonesDir: "/c",
      kbDir: "kb",
      logger,
      readFile: async () => raw,
    });
    expect((await load()).members).toHaveLength(0);
    raw = VALID; // KB へ申告 commit → 次の /ask で clone 更新、を模す
    expect((await load()).members).toHaveLength(1);
  });
});
