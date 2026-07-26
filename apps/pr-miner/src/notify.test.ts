import { describe, expect, it, vi } from "vitest";
import { createWebhookNotifier, type FetchFn } from "./notify.js";

const counts = { new: 2, append: 1, supersede: 0, skip: 1, openQuestions: 3 };

describe("createWebhookNotifier", () => {
  it("webhook 未設定なら no-op", async () => {
    const f = vi.fn();
    await createWebhookNotifier(undefined, f).notifyPrCreated({
      prUrl: "u",
      minedPrs: 5,
      repos: 2,
      counts,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("PR URL と対象サマリを含む JSON を POST する", async () => {
    const f = vi.fn<FetchFn>(async () => ({ ok: true, status: 204 }));
    await createWebhookNotifier("https://hook", f).notifyPrCreated({
      prUrl: "https://github.com/o/kb/pull/9",
      minedPrs: 5,
      repos: 2,
      counts,
    });
    expect(f).toHaveBeenCalledOnce();
    const body = JSON.parse(f.mock.calls[0]?.[1].body ?? "{}") as { content: string };
    expect(body.content).toContain("https://github.com/o/kb/pull/9");
    expect(body.content).toContain("2 リポ / 5 PR");
    expect(body.content).toContain("👍");
  });

  it("非 2xx 応答は warn を残す(throw しない)", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() };
    const f = vi.fn<FetchFn>(async () => ({ ok: false, status: 401 }));
    await createWebhookNotifier("https://hook", f, logger).notifyPrCreated({
      prUrl: "u",
      minedPrs: 1,
      repos: 1,
      counts,
    });
    expect(warn).toHaveBeenCalledWith("通知の投稿に失敗", { status: 401 });
  });

  it("fetch の例外は握りつぶして warn を残す", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() };
    const f = vi.fn<FetchFn>(async () => {
      throw new Error("timeout");
    });
    await expect(
      createWebhookNotifier("https://hook", f, logger).notifyPrCreated({
        prUrl: "u",
        minedPrs: 1,
        repos: 1,
        counts,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("通知の投稿に失敗", { error: "timeout" });
  });
});
