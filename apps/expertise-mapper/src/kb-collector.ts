/**
 * KB evidence コレクタ(ADR-0017 D4)。knowledge/ と decisions/ の frontmatter から
 * owner・people・deciders(いずれも GitHub ユーザ名)を material 別に集計する。
 * questions/ は対象外(回答は answered エントリ化の時点で owner/people に現れる — 二重計上回避)。
 *
 * 走査は自前 readdir + kb-core parseEntry(gap-tracker index.ts の listOpenQuestions と同流儀)。
 * 壊れたエントリは warn + skip(正しさの門番は validateRepo / KB 側 CI)。
 *
 * lastActive の算出源(ADR-0017 の設計):
 *   knowledge の owner   = max(created, last_verified)(owner は鮮度確認で能動的に関与する)
 *   knowledge の people  = created(関与が確実なのは作成時点)
 *   decisions の deciders = date
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEntry } from "@stratum/kb-core";
import { laterDate, type MaterialEvidence, type PersonActivity } from "./evidence.js";
import type { Logger } from "./logger.js";

export interface KbCollectorDeps {
  readFile?: (absPath: string) => Promise<string>;
  readdir?: (absDir: string) => Promise<string[]>;
  logger: Pick<Logger, "warn">;
}

const defaultReaddir = async (absDir: string): Promise<string[]> => {
  try {
    return (await readdir(absDir, { recursive: true })) as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

/** person を一意化しつつ activity を足し込む(count 加算・lastActive は新しい方)。 */
function addActivity(map: Map<string, PersonActivity>, person: string, lastActive: string): void {
  const cur = map.get(person);
  if (cur === undefined) {
    map.set(person, { person, count: 1, lastActive });
  } else {
    map.set(person, {
      person,
      count: cur.count + 1,
      lastActive: laterDate(cur.lastActive, lastActive),
    });
  }
}

export async function collectKbEvidence(
  kbRoot: string,
  deps: KbCollectorDeps,
): Promise<MaterialEvidence[]> {
  const read = deps.readFile ?? ((p: string): Promise<string> => readFile(p, "utf8"));
  const list = deps.readdir ?? defaultReaddir;
  const out: MaterialEvidence[] = [];

  const groups = [
    { subdir: "knowledge", docKind: "knowledge" as const },
    { subdir: "decisions", docKind: "decision" as const },
  ];
  for (const { subdir, docKind } of groups) {
    const files = (await list(join(kbRoot, subdir))).filter((f) => f.endsWith(".md")).sort();
    for (const rel of files) {
      const path = join(kbRoot, subdir, rel);
      let raw: string;
      try {
        raw = await read(path);
      } catch {
        deps.logger.warn("エントリを読めないためスキップします", { path });
        continue;
      }
      try {
        const people = new Map<string, PersonActivity>();
        if (docKind === "knowledge") {
          const fm = parseEntry(raw, "knowledge", path).frontmatter;
          addActivity(people, fm.owner, laterDate(fm.created, fm.last_verified));
          for (const p of fm.people) {
            if (p !== fm.owner) addActivity(people, p, fm.created);
          }
          out.push({
            material: {
              id: `kb:${fm.id}`,
              kind: "kb-entry",
              title: fm.title,
              domain: fm.domain,
              tags: fm.tags,
            },
            people: [...people.values()],
          });
        } else {
          const fm = parseEntry(raw, "decision", path).frontmatter;
          for (const d of fm.deciders) addActivity(people, d, fm.date);
          out.push({
            material: { id: `kb:${fm.id}`, kind: "kb-entry", title: fm.title, tags: fm.tags },
            people: [...people.values()],
          });
        }
      } catch (err) {
        // 壊れた frontmatter は KB 側の validate CI が赤にする。ここでは集計から外すだけ。
        deps.logger.warn("エントリの parse に失敗したためスキップします", {
          path,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return out;
}
