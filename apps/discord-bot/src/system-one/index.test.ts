import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStore } from "../db.js";
import type { SyncedRepo } from "../repos.js";
import type { CatalogCache } from "./catalog.js";
import {
  createSystemOne,
  createSystemOneFromMode,
  loadDefaultWeights,
  parseSystemOneWeights,
  type SystemOneWeights,
} from "./index.js";

const W = loadDefaultWeights();
const NOW = Date.parse("2026-10-08T12:00:00+09:00");
const ISO = "2026-10-08T12:00:00+09:00";

let clones: string;
let synced: SyncedRepo[];

const write = (rel: string, content: string): void => {
  const abs = join(clones, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

beforeAll(() => {
  clones = mkdtempSync(join(tmpdir(), "s1-hook-"));
  write(
    "minutes/meetings/internal/2026/2026-06/2026_06_03_from_10-00_x/minutes.md",
    "# HW 定例 2026-06-03\n\n## エグゼクティブサマリー\n\n- 分注ロボットの Y 軸脱調の対処を決定\n\n高湿度環境で Y 軸が脱調する。対処は除湿機の設置。",
  );
  write("minutes/meetings/internal/2026/2026-06/2026_06_03_from_10-00_x/transcript.md", "秘密");
  synced = [{ repo: "org/minutes", absDir: join(clones, "minutes"), resolvedCommit: "sha1" }];
});
afterAll(() => rmSync(clones, { recursive: true, force: true }));

const QUESTION = "分注ロボットの高湿度での脱調の対処は?";

describe("createSystemOne(/ask のフック・ADR-0041)", () => {
  it("呼び出しごとの Discord 候補源(質問者の範囲)を使い、Discord 候補に抜粋を載せる(ADR-0041 D9)", async () => {
    const seen: string[][] = [];
    const hook = createSystemOne({ mode: "on", weights: W, nowMs: () => NOW, nowIso: () => ISO });
    const block = await hook.prepare({
      queryId: "qd",
      question: QUESTION,
      synced,
      cwd: clones,
      discord: {
        search: async (terms) => {
          seen.push([...terms]);
          return [
            {
              url: "https://discord.com/channels/1/2/3",
              title: "#hw",
              date: "2026-10-07",
              text: "分注ロボットの脱調は高湿度で起きる。除湿機で対処した",
            },
          ];
        },
      },
    });
    expect(seen.length).toBe(1);
    expect(block).toContain("Discord(url: https://discord.com/channels/1/2/3)");
    expect(block).toMatch(/Discord\(url: [^\n]+\n {3}抜粋: 「[^」]*除湿機/);
  });

  it("on: 候補ブロックを返し、判定を記録する(質問文・抜粋は記録しない)", async () => {
    const store = createMemoryStore();
    const hook = createSystemOne({
      mode: "on",
      weights: W,
      store,
      nowMs: () => NOW,
      nowIso: () => ISO,
    });
    const block = await hook.prepare({ queryId: "q1", question: QUESTION, synced, cwd: clones });
    expect(block).toContain("## 候補(System One・確信度: ");
    expect(block).toContain(
      "`minutes/meetings/internal/2026/2026-06/2026_06_03_from_10-00_x/minutes.md`(repo: org/minutes · path: meetings/internal/2026/2026-06/2026_06_03_from_10-00_x/minutes.md)",
    );
    expect(block).not.toContain("transcript");
    const rec = store.getSystemOneDecision("q1");
    expect(rec).toMatchObject({ mode: "on", weightsVersion: W.version, citedJson: null });
    expect(["high", "mid"]).toContain(rec?.gate);
    expect(rec?.candidatesJson).toContain("meetings/internal/2026/2026-06");
    expect(JSON.stringify(rec)).not.toContain("分注ロボットの高湿度");
    expect(JSON.stringify(rec)).not.toContain("除湿機");

    hook.recordCited("q1", [
      { kind: "github_file", repo: "org/minutes", path: "meetings/x/minutes.md" },
      { kind: "discord", url: "https://discord.com/channels/1/2/3" },
    ]);
    expect(JSON.parse(store.getSystemOneDecision("q1")?.citedJson ?? "null")).toEqual([
      { kind: "github_file", repo: "org/minutes", path: "meetings/x/minutes.md" },
      { kind: "discord", url: "https://discord.com/channels/1/2/3" },
    ]);
  });

  it("shadow: 判定と記録だけで前置きしない", async () => {
    const store = createMemoryStore();
    const hook = createSystemOne({
      mode: "shadow",
      weights: W,
      store,
      nowMs: () => NOW,
      nowIso: () => ISO,
    });
    expect(
      await hook.prepare({ queryId: "q2", question: QUESTION, synced, cwd: clones }),
    ).toBeNull();
    expect(store.getSystemOneDecision("q2")?.mode).toBe("shadow");
  });

  it("一致が無い質問は low(前置き無し)", async () => {
    const store = createMemoryStore();
    const hook = createSystemOne({
      mode: "on",
      weights: W,
      store,
      nowMs: () => NOW,
      nowIso: () => ISO,
    });
    expect(
      await hook.prepare({ queryId: "q3", question: "経費精算の締め日は?", synced, cwd: clones }),
    ).toBeNull();
    expect(store.getSystemOneDecision("q3")?.gate).toBe("low");
  });

  it("時間予算を超えたら budget(前置き無し)", async () => {
    const store = createMemoryStore();
    let t = 0;
    const hook = createSystemOne({
      mode: "on",
      weights: W,
      store,
      nowMs: () => NOW,
      nowIso: () => ISO,
      monotonicMs: () => {
        t += 150; // 呼ぶたびに 150ms 進む遅いクロック
        return t;
      },
    });
    expect(
      await hook.prepare({ queryId: "q4", question: QUESTION, synced, cwd: clones }),
    ).toBeNull();
    expect(store.getSystemOneDecision("q4")?.gate).toBe("budget");
  });

  it("カタログ作成が待ちの上限を超えたら catalog_wait(前置き無し)", async () => {
    const store = createMemoryStore();
    const never: CatalogCache = { refresh: () => new Promise(() => {}), current: () => null };
    const weights: SystemOneWeights = { ...W, buildWaitMs: 5 };
    const hook = createSystemOne({ mode: "on", weights, store, cache: never, nowIso: () => ISO });
    expect(
      await hook.prepare({ queryId: "q5", question: QUESTION, synced, cwd: clones }),
    ).toBeNull();
    expect(store.getSystemOneDecision("q5")?.gate).toBe("catalog_wait");
  });

  it("判定の例外は外へ出さず error を記録する", async () => {
    const store = createMemoryStore();
    const warns: string[] = [];
    const hook = createSystemOne({
      mode: "on",
      weights: W,
      store,
      nowIso: () => ISO,
      decider: () => {
        throw new Error("boom");
      },
      logWarn: (_d, msg) => warns.push(msg),
    });
    expect(
      await hook.prepare({ queryId: "q6", question: QUESTION, synced, cwd: clones }),
    ).toBeNull();
    expect(store.getSystemOneDecision("q6")?.gate).toBe("error");
    expect(warns.length).toBe(1);
  });
});

describe("createSystemOneFromMode / weights", () => {
  it("off・未指定なら作らない", () => {
    expect(createSystemOneFromMode(undefined, { nowIso: () => ISO })).toBeUndefined();
    expect(createSystemOneFromMode("off", { nowIso: () => ISO })).toBeUndefined();
    expect(createSystemOneFromMode("shadow", { nowIso: () => ISO })?.mode).toBe("shadow");
  });

  it("weights.json は検証を通り、壊れた重みは拒否する", () => {
    expect(W.gate).toMatchObject({ high: 0.8, mid: 0.5 });
    expect(() => parseSystemOneWeights({ ...W, gate: { ...W.gate, high: 0.3 } })).toThrow();
    expect(() =>
      parseSystemOneWeights({ ...W, relevance: { ...W.relevance, thresholds: [1, 0, 2, 3] } }),
    ).toThrow();
  });
});
