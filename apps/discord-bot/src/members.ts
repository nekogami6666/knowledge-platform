/**
 * members 対応表の読み込み(ADR-0017 D3: KB の `_meta/members.yaml` が唯一の正)。
 * bot はローカル config でなく KB clone(`CLONES_DIR/<kbDir>/_meta/members.yaml`)から読む。
 * KB clone の同期は /ask ごと(ask.ts)で bot 起動時には走らないため、起動時 1 回 load ではなく
 * capture / voice の**実行のたびに都度読み**する(KB への申告 commit が bot 再起動なしで反映される。
 * 反映は「次の /ask で clone が更新された後」— ADR-0017 D3 の許容済みラグ)。
 * 不在・読取失敗・parse 失敗は**空の対応表 + 警告**で続行する(owner は "unassigned" フォールバック)。
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { type Members, parseMembers } from "@stratum/kb-core";
import type { Logger } from "pino";

export const EMPTY_MEMBERS: Members = { members: [] };

/** repos.yaml に ops.kb_repo の項目が無いときの既定 clone ディレクトリ名(repos.yaml.example と同値)。 */
export const DEFAULT_KB_DIR = "knowledge-base";

/** capture / voice が実行のたびに呼ぶ都度読みローダ。 */
export type MembersLoader = () => Promise<Members>;

export function createCloneMembersLoader(deps: {
  clonesDir: string;
  kbDir: string;
  logger: Pick<Logger, "warn">;
  /** 注入用(既定 fs.readFile)。 */
  readFile?: (absPath: string) => Promise<string>;
}): MembersLoader {
  const path = join(deps.clonesDir, deps.kbDir, "_meta", "members.yaml");
  const read = deps.readFile ?? ((p: string): Promise<string> => fsReadFile(p, "utf8"));
  return async () => {
    let raw: string;
    try {
      raw = await read(path);
    } catch {
      // KB clone 未取得(初回 /ask 前)・未申告(§14#8)は準正常系 — 空で続行。
      deps.logger.warn(
        { path },
        "members.yaml が読めないため空の対応表で続行します(KB clone 未取得か未申告)",
      );
      return EMPTY_MEMBERS;
    }
    try {
      return parseMembers(raw, path);
    } catch (err) {
      deps.logger.warn({ path, err }, "members.yaml の parse に失敗したため空の対応表で続行します");
      return EMPTY_MEMBERS;
    }
  };
}
