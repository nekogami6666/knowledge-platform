/**
 * System One の較正 CLI(ADR-0041 D7)。月 1 回、VM で実行して weights.json を作り直す。
 *
 *   node dist/calibrate-system-one.js \
 *     [--labels <bot.db から書き出した JSONL(リポの外)> --corpus <clone ルート> (--map org/name=dir … | --org <org>)] \
 *     [--no-golden] [--refit] [--now <ISO 8601>] [--out <weights.json の出力先>]
 *
 * - 正解: JSONL(system-one-export-labels CLI の出力)と golden-qa(qa-corpus)。
 * - Platt scaling(yes/no・relevance)と温度(primarySource)を当て、`--refit` なら件数 200 以上の判定だけ
 *   特徴量の重みもロジスティック回帰で当て直す。
 * - 信頼度図(10 ビン)と ECE を較正前後で表示する。relevance と answerable の ECE が悪化したら書き出さない。
 * - 書き出すのは数値の重みだけ(質問文は入れない)。`--out` が無ければ表示だけ(dry-run)。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  loadDefaultWeights,
  parseSystemOneWeights,
  type SystemOneWeights,
} from "@stratum/discord-bot/system-one";
import {
  calibrateWeights,
  formatReports,
  type LabeledGroup,
  parseLabelsJsonl,
} from "./system-one-calibration.js";
import {
  catalogOf,
  GOLDEN_NOW_MS,
  goldenAsLabeled,
  loadGolden,
  QA_CORPUS_DIR,
  QA_CORPUS_REPOS,
} from "./system-one-golden.js";

interface Args {
  labels?: string;
  corpus?: string;
  map: { repo: string; dir: string }[];
  org?: string;
  golden: boolean;
  refit: boolean;
  nowMs: number;
  out?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { map: [], golden: true, refit: false, nowMs: Date.now() };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--labels":
        a.labels = v;
        i += 1;
        break;
      case "--corpus":
        a.corpus = v;
        i += 1;
        break;
      case "--map": {
        const m = /^([^=]+)=(.+)$/.exec(v ?? "");
        if (m === null) throw new Error("--map は org/name=dir の形で指定してください");
        a.map.push({ repo: m[1] ?? "", dir: m[2] ?? "" });
        i += 1;
        break;
      }
      case "--org":
        a.org = v;
        i += 1;
        break;
      case "--no-golden":
        a.golden = false;
        break;
      case "--refit":
        a.refit = true;
        break;
      case "--now":
        a.nowMs = Date.parse(v ?? "");
        if (Number.isNaN(a.nowMs)) throw new Error("--now は ISO 8601 で指定してください");
        i += 1;
        break;
      case "--out":
        a.out = v;
        i += 1;
        break;
      default:
        throw new Error(`不明な引数: ${k}`);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base: SystemOneWeights = loadDefaultWeights();
  const groups: LabeledGroup[] = [];
  if (args.golden) {
    groups.push({
      questions: goldenAsLabeled(loadGolden()),
      catalog: await catalogOf(QA_CORPUS_DIR, QA_CORPUS_REPOS),
    });
  }
  if (args.labels !== undefined) {
    if (args.corpus === undefined)
      throw new Error("--labels には --corpus(clone のルート)が必要です");
    const corpus = args.corpus;
    const map =
      args.map.length > 0
        ? args.map
        : args.org !== undefined
          ? readdirSync(corpus, { withFileTypes: true })
              .filter((d) => d.isDirectory() && !d.name.startsWith("."))
              .map((d) => ({ repo: `${args.org}/${d.name}`, dir: d.name }))
          : [];
    if (map.length === 0)
      throw new Error("--map または --org で repo とディレクトリの対応を指定してください");
    groups.push({
      questions: parseLabelsJsonl(readFileSync(args.labels, "utf8")),
      catalog: await catalogOf(corpus, map),
    });
  }
  const nowMs = args.labels === undefined ? GOLDEN_NOW_MS : args.nowMs;
  const { weights, reports } = await calibrateWeights(groups, base, nowMs, { refit: args.refit });
  console.log(formatReports(reports));

  const worse = reports
    .filter((r) => r.name.startsWith("relevance") || r.name === "answerable")
    .filter((r) => r.eceAfter > r.eceBefore + 1e-9);
  if (worse.length > 0) {
    console.error(
      `ECE が悪化したため書き出しません: ${worse.map((r) => r.name).join(", ")}(ラベルを増やして再実行)`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.out === undefined) {
    console.log("--out が無いため書き出しません(dry-run)");
    return;
  }
  const n = groups.reduce((s, g) => s + g.questions.length, 0);
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const out = parseSystemOneWeights({
    ...weights,
    version: `${today}-calibrated`,
    notes: [
      ...base.notes.filter((x) => !x.startsWith("較正:")),
      `較正: ${today}・質問 ${n} 件(golden ${args.golden ? "あり" : "なし"}・bot.db ${args.labels !== undefined ? "あり" : "なし"})・${args.refit ? "重みも当て直し" : "Platt / 温度のみ"}`,
    ],
  });
  writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`weights を書き出しました: ${args.out}`);
}

main().catch((err) => {
  console.error(`calibrate-system-one: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
