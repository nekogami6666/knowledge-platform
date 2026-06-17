/**
 * プロンプトローダ(design.md §8.1)。prompts/<app>/<name>.md を読み、frontmatter
 * (version / role / changelog など)と本文を返す。コード内へのプロンプト直書きは禁止(CLAUDE.md §12.2)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { LlmError } from "./errors.js";
import type { ModelRole } from "./models.js";

/** 読み込んだプロンプト。 */
export interface LoadedPrompt {
  /** 想定モデルロール(frontmatter.role)。 */
  role: ModelRole;
  /** frontmatter を除いた本文(末尾空白を除去)。 */
  body: string;
  /** frontmatter 全体(version / changelog など)。 */
  meta: Record<string, unknown>;
}

/** プロンプトファイルの読み取り口。注入でテスト可能にする(kb-core の IO 注入と同趣旨)。 */
export interface PromptStore {
  /** app/name に対応するファイルの生テキストを返す。存在しなければ throw。 */
  read(app: string, name: string): Promise<string>;
}

const VALID_ROLES: readonly ModelRole[] = ["fast", "standard", "deep"];

/** prompts ルート配下の `<app>/<name>.md` を読む既定ストア。 */
export function createFsPromptStore(promptsRoot: string): PromptStore {
  return {
    async read(app, name) {
      const path = join(promptsRoot, app, `${name}.md`);
      try {
        return await readFile(path, "utf8");
      } catch (cause) {
        throw new LlmError(
          "PROMPT_NOT_FOUND",
          `プロンプトが見つかりません: ${app}/${name} (${path})`,
          { cause },
        );
      }
    },
  };
}

/** app/name のプロンプトを store から読み、frontmatter.role を検証して返す。 */
export async function loadPrompt(
  app: string,
  name: string,
  store: PromptStore,
): Promise<LoadedPrompt> {
  const raw = await store.read(app, name);
  const { data, content } = matter(raw);
  const role = data.role;
  if (typeof role !== "string" || !VALID_ROLES.includes(role as ModelRole)) {
    throw new LlmError(
      "PROMPT_INVALID",
      `プロンプト ${app}/${name} の frontmatter.role が不正です(fast | standard | deep): ${String(role)}`,
    );
  }
  return { role: role as ModelRole, body: content.trim(), meta: data };
}
