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
});
