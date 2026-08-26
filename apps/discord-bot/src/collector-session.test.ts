import { describe, expect, it } from "vitest";
import { type CollectorMessageItem, type FetchPageFn, paginateAfter } from "./collector-session.js";

function msg(id: number): CollectorMessageItem {
  return {
    id: String(id),
    authorId: "1",
    authorName: "yamada",
    authorIsBot: false,
    content: `m${id}`,
    createdAt: new Date(id * 1000),
    hasLightbulb: false,
    url: `https://discord.com/channels/1/2/${id}`,
  };
}

/** 全 250 件(id 1..250)を持つ fake ページャ(oldest-first)。 */
function fakeStore(total: number): { fetchPage: FetchPageFn; calls: (string | null)[] } {
  const all = Array.from({ length: total }, (_, i) => msg(i + 1));
  const calls: (string | null)[] = [];
  const fetchPage: FetchPageFn = async (afterId, limit) => {
    calls.push(afterId);
    const start = afterId === null ? 0 : all.findIndex((m) => m.id === afterId) + 1;
    return all.slice(start, start + limit);
  };
  return { fetchPage, calls };
}

describe("paginateAfter(after カーソルの oldest-first ページング・ADR-0033 D5)", () => {
  it("cap までページを進めて集める(100 件/ページ)", async () => {
    const { fetchPage, calls } = fakeStore(250);
    const out = await paginateAfter(fetchPage, null, 250);
    expect(out).toHaveLength(250);
    expect(out[0]?.id).toBe("1");
    expect(out[249]?.id).toBe("250");
    expect(calls).toEqual([null, "100", "200"]); // カーソルが前進している
  });

  it("cap で打ち切る(cap 未満の最終ページで終了)", async () => {
    const { fetchPage } = fakeStore(250);
    const out = await paginateAfter(fetchPage, null, 150);
    expect(out).toHaveLength(150);
    expect(out[149]?.id).toBe("150");
  });

  it("afterId から再開する(カーソル前進の要)", async () => {
    const { fetchPage } = fakeStore(250);
    const out = await paginateAfter(fetchPage, "240", 100);
    expect(out).toHaveLength(10); // 241..250
    expect(out[0]?.id).toBe("241");
  });

  it("空チャンネル(0 件)は空配列", async () => {
    const { fetchPage } = fakeStore(0);
    expect(await paginateAfter(fetchPage, null, 100)).toEqual([]);
  });
});
