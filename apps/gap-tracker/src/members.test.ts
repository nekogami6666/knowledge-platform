import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { loadMembers } from "./members.js";

const silentLogger = () => createLogger([]);

describe("loadMembers(ADR-0017 D3: 不在/壊れは空表 + warn、正常は解決)", () => {
  it("正常な members.yaml を parse する", async () => {
    const raw = 'members:\n  - github: alice\n    discord: "111"\n';
    const readFile = vi.fn(async () => raw);
    const m = await loadMembers(readFile, "/kb", silentLogger());
    expect(m.members).toEqual([{ github: "alice", discord: "111" }]);
    expect(readFile).toHaveBeenCalledWith("/kb/_meta/members.yaml");
  });

  it("不在(read が throw)は空表 + warn(error 文言つき)で続行", async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn };
    const readFile = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const m = await loadMembers(readFile, "/kb", logger);
    expect(m).toEqual({ members: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ error: expect.stringContaining("ENOENT") });
  });

  it("壊れた YAML は空表 + warn(壊れた申告 PR を追える)", async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn };
    const readFile = vi.fn(async () => "members: [ this is not valid yaml :::");
    const m = await loadMembers(readFile, "/kb", logger);
    expect(m).toEqual({ members: [] });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
