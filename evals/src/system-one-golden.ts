/**
 * golden-qa + qa-corpus を System One の入力にする(ADR-0041 D7)。再現率テストと較正 CLI が共用する。
 * コーパスと repo の対応は run-qa-cli と同じ(synthetic・ADR-0002)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Catalog, classifyPath, createCatalogCache } from "@stratum/discord-bot/system-one";
import { type GoldenQa, loadGoldenQa } from "./golden.js";
import type { LabeledQuestion } from "./system-one-calibration.js";

export const QA_CORPUS_DIR = fileURLToPath(new URL("../fixtures/qa-corpus", import.meta.url));
export const GOLDEN_PATH = fileURLToPath(new URL("../golden-qa.yaml", import.meta.url));

/** qa-corpus のサブディレクトリと repo の対応(run-qa-cli と同じ)。 */
export const QA_CORPUS_REPOS = [
  { repo: "org/minutes", dir: "minutes" },
  { repo: "org/dispenser-fw", dir: "dispenser-fw" },
  { repo: "org/knowledge-base", dir: "knowledge-base" },
] as const;

/** golden の「今」(fixture の日付 2026-06 に対し、時間表現を含まない質問なので鮮度の基準にだけ使う)。 */
export const GOLDEN_NOW_MS = Date.parse("2026-10-08T12:00:00+09:00");

export function loadGolden(): GoldenQa[] {
  return loadGoldenQa(readFileSync(GOLDEN_PATH, "utf8"));
}

/** corpus ルート配下の repo ↔ dir の対応からカタログを作る。 */
export async function catalogOf(
  root: string,
  repos: readonly { repo: string; dir: string }[],
): Promise<Catalog> {
  return createCatalogCache().refresh(
    repos.map((r) => ({ repo: r.repo, absDir: join(root, r.dir), sha: "fixture" })),
  );
}

/** 引用(QaCitation 形)の種別。 */
export function kindOfCitation(c: { kind: string; path?: string }): string {
  if (c.kind === "discord") return "discord";
  if (c.kind !== "github_file" || c.path === undefined) return "code";
  const k = classifyPath(c.path);
  return k === "other" ? "code" : k;
}

/** golden の expected_sources を正解の引用として扱う(not_found は引用なし)。 */
export function goldenAsLabeled(golden: readonly GoldenQa[]): LabeledQuestion[] {
  return golden.map((g) => {
    const cited = g.expected_sources.map((s) =>
      s.kind === "discord"
        ? { kind: s.kind, url: s.url }
        : s.kind === "github_file"
          ? { kind: s.kind, repo: s.repo, path: s.path }
          : { kind: s.kind, repo: s.repo },
    );
    return { question: g.question, cited, citedKinds: cited.map((c) => kindOfCitation(c)) };
  });
}
