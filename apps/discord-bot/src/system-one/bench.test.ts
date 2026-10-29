/**
 * System One の速度の計測(ADR-0041「影響・トレードオフ」)。合成コーパス(KB 500 件 + 議事録 600 件)で
 * カタログ作成と判定(runSystemOne = 語の抽出・候補選定・判定・ブロック)の所要時間を測って表示する。
 * 目標は判定の p95 ≤ 100ms。CI の負荷で揺れるため、テストの上限は余裕を持たせる(250ms)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogCache, loadDefaultWeights, runSystemOne } from "./index.js";

const WORDS = [
  "分注",
  "ロボット",
  "湿度",
  "脱調",
  "ファーム",
  "キャリブレーション",
  "量産",
  "治具",
  "センサー",
  "ポンプ",
  "バルブ",
  "温度補正",
  "試薬",
  "プレート",
  "搬送",
  "アーム",
  "ノズル",
  "洗浄",
  "検査",
  "顧客",
  "見積",
  "納期",
  "設計審査",
  "基板",
  "電源",
  "通信",
  "ログ",
  "エラー",
  "再現",
  "対策",
];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const rnd = lcg(1234);
const pick = (): string => WORDS[Math.floor(rnd() * WORDS.length)] ?? "分注";
const sentence = (): string =>
  `${pick()}の${pick()}について、${pick()}と${pick()}を確認した。${pick()}は継続して${pick()}を進める。`;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "s1-bench-"));
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (let i = 0; i < 500; i += 1) {
    const id = `kb-2026-${String(i).padStart(4, "0")}`;
    const body = Array.from({ length: 8 }, sentence).join("\n");
    write(
      `kb/knowledge/hw/${id}.md`,
      `---\nid: ${id}\ntitle: ${pick()}の${pick()}と${pick()}\ntype: procedure\ndomain: hw\ntags: ["${pick()}", "${pick()}"]\nsources:\n  - kind: meeting\n    repo: org/minutes\n    path: x.md\npeople: ["a"]\nconfidence: medium\nstatus: active\ncreated: "2026-0${1 + (i % 9)}-1${i % 9}"\nlast_verified: "2026-09-01"\nowner: a\n---\n\n${body}\n`,
    );
  }
  for (let i = 0; i < 600; i += 1) {
    const m = 1 + (i % 9);
    const d = 10 + (i % 18);
    const date = `2026_0${m}_${d}`;
    const body = Array.from({ length: 60 }, sentence).join("\n"); // 約 5KB
    write(
      `minutes/meetings/internal/2026/2026-0${m}/${date}_from_10-00_to_11-00_${i}/minutes.md`,
      `# 定例 ${date}\n\n## エグゼクティブサマリー\n\n- ${sentence()}\n\n## 議題\n\n${body}\n`,
    );
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const QUESTIONS = [
  "分注ロボットの湿度による脱調の対策は?",
  "先月の量産治具の検査で何が決まった?",
  "ファームのキャリブレーションと温度補正の関係は?",
  "最近のポンプとバルブの洗浄手順は?",
  "顧客への見積と納期の状況を教えて",
  "基板の電源と通信のエラーは再現した?",
  "9月の設計審査で決まったこと",
  "ノズルの洗浄について",
];

/** 分位点(最近傍順位法)。 */
const pct = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))] ?? 0;
};

describe("System One の速度(合成コーパス KB 500 + 議事録 600)", () => {
  it("カタログ作成と判定の所要時間を測る(判定の p95 を表示)", async () => {
    const cache = createCatalogCache();
    const t0 = performance.now();
    const catalog = await cache.refresh([
      { repo: "org/kb", absDir: join(root, "kb"), sha: "1" },
      { repo: "org/minutes", absDir: join(root, "minutes"), sha: "1" },
    ]);
    const buildMs = performance.now() - t0;
    expect(catalog.entries.length).toBe(1100);
    const weights = { ...loadDefaultWeights(), budgetMs: 10_000 }; // 計測のため打ち切らない
    const times: number[] = [];
    const now = Date.parse("2026-10-08T12:00:00+09:00");
    for (let round = 0; round < 8; round += 1) {
      for (const q of QUESTIONS) {
        const s = performance.now();
        await runSystemOne({ question: q, catalog, weights, nowMs: now });
        times.push(performance.now() - s);
      }
    }
    const t1 = performance.now();
    await cache.refresh([
      { repo: "org/kb", absDir: join(root, "kb"), sha: "1" },
      { repo: "org/minutes", absDir: join(root, "minutes"), sha: "1" },
    ]);
    const cachedMs = performance.now() - t1;
    const bytes = catalog.repos.reduce((s, r) => s + r.stats.bytes, 0);
    console.log(
      `System One bench: カタログ作成 ${buildMs.toFixed(0)}ms(${catalog.entries.length} 件・${(bytes / 1e6).toFixed(1)}MB)・` +
        `キャッシュ再利用 ${cachedMs.toFixed(1)}ms・判定 n=${times.length} p50 ${pct(times, 0.5).toFixed(1)}ms ` +
        `p95 ${pct(times, 0.95).toFixed(1)}ms max ${Math.max(...times).toFixed(1)}ms`,
    );
    expect(pct(times, 0.95)).toBeLessThan(250);
  }, 60_000);
});
