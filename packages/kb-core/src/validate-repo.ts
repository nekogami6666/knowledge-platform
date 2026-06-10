import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, posix, sep } from "node:path";
import { JSON_SCHEMA, load as yamlLoad } from "js-yaml";
import { type DocKind, safeParseEntry } from "./entry-io.js";
import { type KbIssue, zodErrorToIssues } from "./errors.js";
import { ID_PREFIX_RE } from "./schemas/common.js";
import { expertiseMapSchema } from "./schemas/expertise-map.js";

/**
 * knowledge-base ディレクトリ全体のスキーマ検証(design.md §6.1)。
 * 1 ファイルのエラーで止めず全件報告する。CI / pre-merge から CLI 経由で実行する。
 *
 * 検証範囲(本 PR):
 *   - frontmatter / YAML スキーマ
 *   - ファイル名の ID と frontmatter の id 一致
 *   - knowledge/<domain> のディレクトリ名と domain 一致
 *   - knowledge/ 配下に type:decision を置かない(本体は decisions/。論点 D-2)
 *   - questions の status とディレクトリ(open/ ・ answered/)の整合
 *   - ID の重複検出
 * 参照整合性(supersedes / resulting_kb の実在)は将来拡張。
 */
export interface RepoProblem {
  /** repoRoot からの相対パス(POSIX 区切り)。 */
  file: string;
  issues: KbIssue[];
}

export interface RepoValidationReport {
  ok: boolean;
  checkedFiles: number;
  problems: RepoProblem[];
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

/** subdir 配下の指定拡張子ファイルを repoRoot 相対(POSIX)で列挙。subdir 不在なら []。 */
async function listFiles(repoRoot: string, subdir: string, ext: string): Promise<string[]> {
  const abs = join(repoRoot, subdir);
  let entries: string[];
  try {
    entries = await readdir(abs, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((e) => e.endsWith(ext))
    .map((e) => toPosix(join(subdir, e)))
    .sort();
}

/** ファイル名先頭から ID(kb-YYYY-NNNN 等)を取り出す。なければ null。 */
function idFromFilename(file: string): string | null {
  const m = ID_PREFIX_RE.exec(basename(file));
  return m ? m[0] : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** questions の配置(depth・open/answered の別)と status の整合を検査する。 */
function questionCheck(
  file: string,
  fm: Record<string, unknown>,
  dir: "open" | "answered",
): KbIssue[] {
  // 期待レイアウト: questions/<open|answered>/<id>.md(§4.4)。ネストは想定外。
  if (file.split("/").length !== 3) {
    return [
      {
        path: "(file)",
        message: `想定外の配置です。questions/${dir}/<file>.md に置いてください: ${file}`,
        code: "stray_file",
      },
    ];
  }
  const status = fm["status"];
  const expectedHere =
    dir === "open"
      ? status === "open" || status === "asked"
      : status === "answered" || status === "wontfix";
  if (!expectedHere) {
    const correct = dir === "open" ? "questions/answered/" : "questions/open/";
    return [
      {
        path: "status",
        message: `status "${String(status)}" は ${correct} に置きます`,
        code: "question_dir_mismatch",
      },
    ];
  }
  return [];
}

export async function validateRepo(repoRoot: string): Promise<RepoValidationReport> {
  const problems: RepoProblem[] = [];
  let checkedFiles = 0;
  /** id → それを宣言したファイル一覧(重複検出用)。 */
  const idOwners = new Map<string, string[]>();

  function addIssues(file: string, issues: KbIssue[]): void {
    if (issues.length > 0) problems.push({ file, issues });
  }

  function recordId(id: string, file: string): void {
    const owners = idOwners.get(id) ?? [];
    owners.push(file);
    idOwners.set(id, owners);
  }

  // --- fail-closed: ゲートの空振り防止(存在しないパス・KB に見えないディレクトリ) ---
  if (!(await pathExists(repoRoot))) {
    return {
      ok: false,
      checkedFiles: 0,
      problems: [
        {
          file: "(repo)",
          issues: [
            {
              path: "(root)",
              message: `repoRoot が存在しません: ${repoRoot}`,
              code: "repo_not_found",
            },
          ],
        },
      ],
    };
  }
  const topDirs = await Promise.all(
    ["knowledge", "decisions", "questions"].map((d) => pathExists(join(repoRoot, d))),
  );
  const hasExpertise = await pathExists(join(repoRoot, "expertise", "expertise.yaml"));
  if (!topDirs.some(Boolean) && !hasExpertise) {
    problems.push({
      file: "(repo)",
      issues: [
        {
          path: "(root)",
          message:
            "knowledge-base に見えません(knowledge/ ・ decisions/ ・ questions/ ・ expertise/expertise.yaml がいずれも存在しません)",
          code: "not_a_kb",
        },
      ],
    });
  }

  // --- knowledge / decisions / questions(frontmatter ドキュメント) ---
  const docGroups: Array<{
    files: string[];
    docKind: DocKind;
    check: (file: string, fm: Record<string, unknown>) => KbIssue[];
  }> = [
    {
      files: await listFiles(repoRoot, "knowledge", ".md"),
      docKind: "knowledge",
      check: (file, fm) => {
        const issues: KbIssue[] = [];
        // 期待レイアウト: knowledge/<domain>/<id>-<slug>.md(§4.1.2)
        const parts = file.split("/");
        if (parts.length !== 3) {
          issues.push({
            path: "(file)",
            message: `想定外の配置です。knowledge/<domain>/<file>.md に置いてください: ${file}`,
            code: "stray_file",
          });
        } else if (fm["domain"] !== parts[1]) {
          // domain == 直上のディレクトリ名
          issues.push({
            path: "domain",
            message: `domain "${String(fm["domain"])}" がディレクトリ名 "${parts[1]}" と一致しません`,
            code: "domain_mismatch",
          });
        }
        if (fm["type"] === "decision") {
          issues.push({
            path: "type",
            message: "type:decision の本体は decisions/ に置きます(knowledge/ には置けません)",
            code: "decision_in_knowledge",
          });
        }
        return issues;
      },
    },
    {
      files: await listFiles(repoRoot, "decisions", ".md"),
      docKind: "decision",
      // 期待レイアウト: decisions/<年4桁>/<id>-<slug>.md(§4.1.2)
      check: (file) => {
        const parts = file.split("/");
        return parts.length === 3 && /^\d{4}$/.test(parts[1] ?? "")
          ? []
          : [
              {
                path: "(file)",
                message: `想定外の配置です。decisions/<年>/<file>.md に置いてください: ${file}`,
                code: "stray_file",
              },
            ];
      },
    },
    {
      files: await listFiles(repoRoot, join("questions", "open"), ".md"),
      docKind: "question",
      check: (file, fm) => questionCheck(file, fm, "open"),
    },
    {
      files: await listFiles(repoRoot, join("questions", "answered"), ".md"),
      docKind: "question",
      check: (file, fm) => questionCheck(file, fm, "answered"),
    },
  ];

  for (const group of docGroups) {
    for (const file of group.files) {
      checkedFiles++;
      const raw = await readFile(join(repoRoot, file), "utf8");
      const result = safeParseEntry(raw, group.docKind, file);
      if (!result.ok) {
        addIssues(
          file,
          result.error.issues.length > 0
            ? result.error.issues
            : [{ path: "(root)", message: result.error.message, code: result.error.code }],
        );
        continue;
      }
      const fm = result.entry.frontmatter as Record<string, unknown>;
      const id = fm["id"] as string;
      recordId(id, file);

      const structural: KbIssue[] = [];
      const fileId = idFromFilename(file);
      if (fileId === null) {
        structural.push({
          path: "(file)",
          message: `ファイル名が ID で始まっていません(<id>-<slug>.md 形式が必要): ${file}`,
          code: "filename_id_mismatch",
        });
      } else if (fileId !== id) {
        structural.push({
          path: "id",
          message: `frontmatter の id "${id}" がファイル名の ID "${fileId}" と一致しません`,
          code: "filename_id_mismatch",
        });
      }
      structural.push(...group.check(file, fm));
      addIssues(file, structural);
    }
  }

  // --- questions/ 配下で open/ ・ answered/ 以外に置かれた迷子ファイル(無検証通過の防止) ---
  for (const file of await listFiles(repoRoot, "questions", ".md")) {
    const seg = file.split("/")[1];
    if (seg !== "open" && seg !== "answered") {
      checkedFiles++;
      addIssues(file, [
        {
          path: "(file)",
          message: `想定外の配置です。questions/open/ または questions/answered/ に置いてください: ${file}`,
          code: "stray_file",
        },
      ]);
    }
  }

  // --- expertise/expertise.yaml(純 YAML、存在すれば検証) ---
  const expertisePath = join("expertise", "expertise.yaml");
  let expertiseRaw: string | null = null;
  try {
    expertiseRaw = await readFile(join(repoRoot, expertisePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (expertiseRaw !== null) {
    checkedFiles++;
    let data: unknown;
    try {
      data = yamlLoad(expertiseRaw, { schema: JSON_SCHEMA });
    } catch {
      addIssues(expertisePath, [
        { path: "(root)", message: "YAML 構文が不正です", code: "INVALID_YAML" },
      ]);
      data = undefined;
    }
    if (data !== undefined) {
      const parsed = expertiseMapSchema.safeParse(data);
      if (!parsed.success) addIssues(expertisePath, zodErrorToIssues(parsed.error));
    }
  }

  // --- ID 重複 ---
  for (const [id, owners] of idOwners) {
    if (owners.length > 1) {
      for (const file of owners) {
        problems.push({
          file,
          issues: [
            {
              path: "id",
              message: `ID "${id}" が複数ファイルで重複しています: ${owners.join(", ")}`,
              code: "duplicate_id",
            },
          ],
        });
      }
    }
  }

  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { ok: problems.length === 0, checkedFiles, problems };
}
