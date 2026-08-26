import { describe, expect, it } from "vitest";
import { filterMessages, groupIntoWindows, type WindowMessage } from "./window.js";

let seq = 0;
function msg(over: Partial<WindowMessage> = {}): WindowMessage {
  seq += 1;
  return {
    id: String(1000 + seq),
    authorId: "u1",
    authorName: "user",
    authorIsBot: false,
    content: `メッセージ ${seq}`,
    createdAt: new Date("2026-08-21T10:00:00Z"),
    hasLightbulb: false,
    url: `https://discord.com/channels/1/2/${1000 + seq}`,
    ...over,
  };
}

describe("filterMessages", () => {
  it("bot / 💡 付き / 空本文 / 既知 URL を内訳付きで落とし、残りを保持する", () => {
    const keep = msg();
    const bot = msg({ authorIsBot: true });
    const bulb = msg({ hasLightbulb: true });
    const empty = msg({ content: "  \n " });
    const known = msg();
    const { kept, dropped } = filterMessages([keep, bot, bulb, empty, known], new Set([known.url]));
    expect(kept).toEqual([keep]);
    expect(dropped).toEqual({ bot: 1, lightbulb: 1, empty: 1, knownUrl: 1 });
  });

  it("空入力は空", () => {
    expect(filterMessages([], new Set())).toEqual({
      kept: [],
      dropped: { bot: 0, lightbulb: 0, empty: 0, knownUrl: 0 },
    });
  });
});

describe("groupIntoWindows", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 7, 21, 10, min, 0));

  it("gap 分数を超えた沈黙で区切る(ちょうどは区切らない)", () => {
    const a = msg({ createdAt: at(0) });
    const b = msg({ createdAt: at(30) }); // ちょうど 30 分 → 同一ウィンドウ
    const c = msg({ createdAt: at(61) }); // 31 分ギャップ → 新ウィンドウ
    const w = groupIntoWindows([a, b, c], { gapMinutes: 30, maxMessages: 50 });
    expect(w).toEqual([[a, b], [c]]);
  });

  it("maxMessages 到達で区切る", () => {
    const ms = [msg({ createdAt: at(0) }), msg({ createdAt: at(1) }), msg({ createdAt: at(2) })];
    const w = groupIntoWindows(ms, { gapMinutes: 30, maxMessages: 2 });
    expect(w.map((x) => x.length)).toEqual([2, 1]);
  });

  it("maxChars 超過で区切る(プロンプト有界の防御)", () => {
    const a = msg({ content: "あ".repeat(60), createdAt: at(0) });
    const b = msg({ content: "い".repeat(60), createdAt: at(1) });
    const w = groupIntoWindows([a, b], { gapMinutes: 30, maxMessages: 50, maxChars: 100 });
    expect(w).toEqual([[a], [b]]);
  });

  it("空入力は空・単発は 1 ウィンドウ", () => {
    expect(groupIntoWindows([], { gapMinutes: 30, maxMessages: 50 })).toEqual([]);
    const a = msg();
    expect(groupIntoWindows([a], { gapMinutes: 30, maxMessages: 50 })).toEqual([[a]]);
  });
});
