/**
 * KB `_meta/members.yaml`(github↔discord 対応表・唯一の正・ADR-0017 D3)の読み込み。
 * freshness-checker の loadMembers と同流儀: 不在/壊れは空表 + warn で続行(§14#8 移行期は
 * 未整備が正常)。壊れた申告 PR を追えるよう parse エラーは error 文言つきで残す
 * (logger はシークレットをスクラブ)。**sync 失敗はここでは扱わない**(呼び出し側が事前
 * sync で fail-loud させ、members 読み失敗に誤誘導しないため・R-1)。
 */
import { join } from "node:path";
import { KbParseError, type Members, parseMembers } from "@stratum/kb-core";
import type { Logger } from "./logger.js";

export async function loadMembers(
  readFile: (path: string) => Promise<string>,
  kbRoot: string,
  logger: Logger,
): Promise<Members> {
  const path = join("_meta", "members.yaml");
  try {
    return parseMembers(await readFile(join(kbRoot, path)), path);
  } catch (e) {
    // 壊れた申告 PR を追えるよう、KbParseError なら不正フィールド(issues)まで残す。
    const detail =
      e instanceof KbParseError ? { error: String(e), issues: e.issues } : { error: String(e) };
    logger.warn(
      "members.yaml を読めないため discord↔github 解決は assignees のみです(§14#8)",
      detail,
    );
    return { members: [] };
  }
}
