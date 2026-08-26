import { type AgentSearchOptions, LlmError, type PromptStore } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import { type ExtractionResult, extractionResultSchema } from "../candidate.js";
import type { ExtractSearchFn } from "../extract.js";
import { buildDiscordExtractPrompt, extractFromWindow } from "./extract.js";
import type { WindowMessage } from "./window.js";

const fakePromptStore: PromptStore = {
  read: async () => "---\nrole: standard\n---\nDISCORD EXTRACT RULES",
};

const empty: ExtractionResult = { decisions: [], learnings: [], openQuestions: [] };

function msg(over: Partial<WindowMessage> = {}): WindowMessage {
  return {
    id: "1001",
    authorId: "u1",
    authorName: "Yoshimasa Muneishi",
    authorIsBot: false,
    content: "湿度しきい値は 40%RH にする",
    createdAt: new Date("2026-08-21T01:30:00Z"),
    hasLightbulb: false,
    url: "https://discord.com/channels/100/200/1001",
    ...over,
  };
}

function fakeSearch(value: ExtractionResult) {
  const captured: { opts?: AgentSearchOptions<ExtractionResult> } = {};
  const search: ExtractSearchFn = async (opts) => {
    captured.opts = opts;
    return { value, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { search, captured };
}

describe("buildDiscordExtractPrompt", () => {
  it("正規化済み著者ラベルと本文・JST の期間レンジを含む", () => {
    const w = [
      msg(),
      msg({
        id: "1002",
        authorName: "Hayate Okumura",
        content: "了解、理由は結露対策",
        createdAt: new Date("2026-08-21T02:00:00Z"),
      }),
    ];
    const p = buildDiscordExtractPrompt(w, []);
    expect(p).toContain("[Yoshimasa Muneishi] 湿度しきい値は 40%RH にする");
    expect(p).toContain("[Hayate Okumura] 了解、理由は結露対策");
    expect(p).toContain("2026-08-21 10:30 〜 2026-08-21 11:00(JST)"); // UTC+9
    expect(p).toContain("--- 会話ここから ---");
  });

  it("既存 domain を提示する(空なら行ごと出さない)", () => {
    expect(buildDiscordExtractPrompt([msg()], ["hardware", "firmware"])).toContain(
      "既存 domain(なるべくここから選ぶ・無ければ新設): firmware, hardware",
    );
    expect(buildDiscordExtractPrompt([msg()], [])).not.toContain("既存 domain");
  });

  it("1 メッセージの本文を 1000 字で切り詰める", () => {
    const long = "あ".repeat(1_500);
    const p = buildDiscordExtractPrompt([msg({ content: long })], []);
    expect(p).toContain(`${"あ".repeat(1_000)}…`);
    expect(p).not.toContain("あ".repeat(1_001));
  });
});

describe("extractFromWindow", () => {
  it("ツール無し単発で抽出する(allowedTools:[]・app・role・outputSchema・プロンプト由来)", async () => {
    const { search, captured } = fakeSearch(empty);
    await extractFromWindow(
      { window: [msg()], cwd: "/kb" },
      { promptStore: fakePromptStore, search },
    );
    expect(captured.opts?.app).toBe("extractor-discord");
    expect(captured.opts?.role).toBe("standard");
    expect(captured.opts?.allowedTools).toEqual([]);
    expect(captured.opts?.outputSchema).toBe(extractionResultSchema);
    expect(captured.opts?.systemPrompt).toBe("DISCORD EXTRACT RULES");
    expect(captured.opts?.prompt).toContain("[Yoshimasa Muneishi]");
    expect(captured.opts?.cwd).toBe("/kb");
    expect(captured.opts?.timeoutMs).toBe(300_000);
  });

  it("timeoutMs を deps から上書きできる", async () => {
    const { search, captured } = fakeSearch(empty);
    await extractFromWindow(
      { window: [msg()], cwd: "/kb" },
      { promptStore: fakePromptStore, search, timeoutMs: 60_000 },
    );
    expect(captured.opts?.timeoutMs).toBe(60_000);
  });

  it("TIMEOUT はリトライしない(retryableExceptTimeout・入力非有界の暴走上限)", async () => {
    let calls = 0;
    const search: ExtractSearchFn = async () => {
      calls += 1;
      throw new LlmError("TIMEOUT", "timed out");
    };
    await expect(
      extractFromWindow(
        { window: [msg()], cwd: "/kb" },
        { promptStore: fakePromptStore, search, retry: { sleep: async () => {} } },
      ),
    ).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });

  it("RATE_LIMITED は 1 回だけリトライする", async () => {
    let calls = 0;
    const search: ExtractSearchFn = async () => {
      calls += 1;
      if (calls === 1) throw new LlmError("RATE_LIMITED", "429");
      return { value: empty, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await extractFromWindow(
      { window: [msg()], cwd: "/kb" },
      { promptStore: fakePromptStore, search, retry: { sleep: async () => {} } },
    );
    expect(calls).toBe(2);
    expect(r.value).toEqual(empty);
  });
});
