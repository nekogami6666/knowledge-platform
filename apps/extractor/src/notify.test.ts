import { describe, expect, it } from "vitest";
import { createWebhookNotifier, type FetchFn, type NotifyCounts } from "./notify.js";

const counts: NotifyCounts = { new: 1, append: 0, supersede: 0, skip: 0, openQuestions: 2 };

describe("createWebhookNotifier", () => {
  it("webhook に PR URL と件数を POST する", async () => {
    let body = "";
    const fetchFn: FetchFn = async (_url, init) => {
      body = init.body;
      return { ok: true, status: 204 };
    };
    await createWebhookNotifier("https://hook", fetchFn).notifyPrCreated({
      prUrl: "https://pr",
      counts,
      people: ["yamada"],
    });
    expect(body).toContain("https://pr");
    expect(body).toContain("新規 1");
    expect(body).toContain("yamada");
  });
  it("webhook 未設定なら no-op(fetch を呼ばない)", async () => {
    let called = false;
    const fetchFn: FetchFn = async () => {
      called = true;
      return { ok: true, status: 200 };
    };
    await createWebhookNotifier(undefined, fetchFn).notifyPrCreated({
      prUrl: "x",
      counts,
      people: [],
    });
    expect(called).toBe(false);
  });
  it("非 2xx 応答は warn を残す(throw しない)", async () => {
    const warns: unknown[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => warns.push([msg, data]),
      error: () => {},
    };
    const fetchFn: FetchFn = async () => ({ ok: false, status: 404 });
    await createWebhookNotifier("https://hook", fetchFn, logger).notifyPrCreated({
      prUrl: "x",
      counts,
      people: [],
    });
    expect(warns).toEqual([["通知の投稿に失敗", { status: 404 }]]);
  });
  it("fetch の例外は握りつぶして warn を残す(run を落とさない)", async () => {
    const warns: unknown[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => warns.push([msg, data]),
      error: () => {},
    };
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      createWebhookNotifier("https://hook", fetchFn, logger).notifyPrCreated({
        prUrl: "x",
        counts,
        people: [],
      }),
    ).resolves.toBeUndefined();
    expect(warns).toEqual([["通知の投稿に失敗", { error: "ECONNREFUSED" }]]);
  });

  it("reviewer 付きの PR 作成通知はレビュー担当をメンションする(㉘)", async () => {
    let body = "";
    const fetchFn: FetchFn = async (_url, init) => {
      body = init.body;
      return { ok: true, status: 204 };
    };
    await createWebhookNotifier("https://hook", fetchFn).notifyPrCreated({
      prUrl: "https://pr",
      counts,
      people: [],
      reviewer: "12345",
    });
    expect(body).toContain("<@12345>");
    expect(body).toContain("レビュー担当");
  });

  it("reviewer 無しの通知はメンションを含まない(従来挙動)", async () => {
    let body = "";
    const fetchFn: FetchFn = async (_url, init) => {
      body = init.body;
      return { ok: true, status: 204 };
    };
    const n = createWebhookNotifier("https://hook", fetchFn);
    await n.notifyPrCreated({ prUrl: "https://pr", counts, people: [] });
    expect(body).not.toContain("<@");
    await n.notifySkipped({ prUrl: "https://pr" });
    expect(body).not.toContain("<@");
  });

  it("reviewer 付きの skip 通知は滞留 PR のレビューを依頼する(㉘)", async () => {
    let body = "";
    const fetchFn: FetchFn = async (_url, init) => {
      body = init.body;
      return { ok: true, status: 204 };
    };
    await createWebhookNotifier("https://hook", fetchFn).notifySkipped({
      prUrl: "https://pr",
      reviewer: "67890",
    });
    expect(body).toContain("<@67890>");
    expect(body).toContain("レビューをお願いします");
  });
});
