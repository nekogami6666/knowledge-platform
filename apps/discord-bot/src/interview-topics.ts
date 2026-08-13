/**
 * 面談パネルの topic 候補ローダ(ADR-0028 / design.md §6.6 ⑤-b の UI 拡張)。
 * KB clone の `expertise/expertise.yaml`(§4.5・自動生成)を kb-core の parseExpertiseMap で読み、
 * StringSelectMenu の選択肢 `{value: topic キー, label: 表示ラベル}` へ写す。
 * members.ts と同じ都度読み方式(KB clone の更新が bot 再起動なしで反映される)。
 * ファイル欠落・parse 失敗は**空配列 + 警告**で続行する(パネルは「その他(自由入力)」だけで動く)。
 */
import { join } from "node:path";
import { parseExpertiseMap } from "@stratum/kb-core";
import type { Logger } from "pino";

/** StringSelectMenu の 1 選択肢(value = expertise.yaml の topic キー)。 */
export interface InterviewTopicOption {
  value: string;
  label: string;
}

/**
 * Discord の StringSelectMenu は最大 25 選択肢。先頭に「✏️ その他(自由入力)」を置くため
 * expertise 由来の候補は 24 件に切り詰める。
 */
export const MAX_TOPIC_OPTIONS = 24;

/**
 * KB clone の expertise.yaml から topic 候補を読む(kbCloneDir = CLONES_DIR/<kbDir> の絶対パス)。
 * readFile は注入用(既定 fs.readFile。members.ts の createCloneMembersLoader と同じ seam)。
 */
export async function loadInterviewTopics(
  readFile: (absPath: string) => Promise<string>,
  kbCloneDir: string,
  logger: Pick<Logger, "warn">,
): Promise<InterviewTopicOption[]> {
  const path = join(kbCloneDir, "expertise", "expertise.yaml");
  let raw: string;
  try {
    raw = await readFile(path);
  } catch {
    // KB clone 未取得(初回 /ask 前)や expertise 未生成は準正常系 — 「その他」だけで続行。
    logger.warn({ path }, "expertise.yaml が読めないため topic 候補なしで続行します(自由入力のみ)");
    return [];
  }
  try {
    const map = parseExpertiseMap(raw, path);
    return map.topics.slice(0, MAX_TOPIC_OPTIONS).map((t) => ({ value: t.topic, label: t.label }));
  } catch (err) {
    logger.warn(
      { path, err },
      "expertise.yaml の parse に失敗したため topic 候補なしで続行します(自由入力のみ)",
    );
    return [];
  }
}
