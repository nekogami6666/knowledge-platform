import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmError } from "./errors.js";
import { createFsPromptStore, loadPrompt, type PromptStore } from "./prompts.js";

function storeOf(content: string): PromptStore {
  return { read: () => Promise.resolve(content) };
}

const VALID = `---
role: standard
version: 1
---
# answer

本文です。
`;

describe("loadPrompt", () => {
  it("frontmatter.role と本文(末尾trim)を返す", async () => {
    const p = await loadPrompt("qa", "answer", storeOf(VALID));
    expect(p.role).toBe("standard");
    expect(p.body.startsWith("# answer")).toBe(true);
    expect(p.body.endsWith("本文です。")).toBe(true);
    expect(p.meta.version).toBe(1);
  });

  it("role が無ければ PROMPT_INVALID を投げる", async () => {
    const noRole = "---\nversion: 1\n---\nbody\n";
    await expect(loadPrompt("qa", "answer", storeOf(noRole))).rejects.toMatchObject({
      code: "PROMPT_INVALID",
    });
  });

  it("role が不正値なら PROMPT_INVALID を投げる", async () => {
    const bad = "---\nrole: wizard\n---\nbody\n";
    await expect(loadPrompt("qa", "answer", storeOf(bad))).rejects.toBeInstanceOf(LlmError);
  });

  it("store.read の失敗をそのまま伝播する", async () => {
    const failing: PromptStore = {
      read: () => Promise.reject(new LlmError("PROMPT_NOT_FOUND", "nope")),
    };
    await expect(loadPrompt("qa", "answer", failing)).rejects.toMatchObject({
      code: "PROMPT_NOT_FOUND",
    });
  });
});

describe("createFsPromptStore", () => {
  it("存在しないファイルは PROMPT_NOT_FOUND を投げる", async () => {
    const store = createFsPromptStore("/nonexistent-prompts-root-xyz");
    await expect(store.read("qa", "answer")).rejects.toMatchObject({ code: "PROMPT_NOT_FOUND" });
  });
});

describe("createFsPromptStore(実ファイル)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stratum-prompts-"));
    await mkdir(join(root, "qa"), { recursive: true });
    await writeFile(join(root, "qa", "answer.md"), VALID, "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("実ファイルを読み、loadPrompt で role/body を返す", async () => {
    const store = createFsPromptStore(root);
    const loaded = await loadPrompt("qa", "answer", store);
    expect(loaded.role).toBe("standard");
    expect(loaded.body.startsWith("# answer")).toBe(true);
  });
});
