import { describe, expect, it, vi } from "vitest";
import { createWebhookNotifier, type FetchFn, type RiskNotice } from "./notify.js";

const items: RiskNotice[] = [{ topic: "ros2-control", label: "ROS2 制御", top: "yamada" }];

describe("createWebhookNotifier", () => {
  it("webhook 未設定なら no-op", async () => {
    const f = vi.fn();
    await createWebhookNotifier(undefined, f).notifyHighRisk(items, "expertise/report.md");
    expect(f).not.toHaveBeenCalled();
  });

  it("risk:high が 0 件なら通知しない(通知疲れ防止)", async () => {
    const f = vi.fn<FetchFn>(async () => ({ ok: true, status: 204 }));
    await createWebhookNotifier("https://hook", f).notifyHighRisk([], "expertise/report.md");
    expect(f).not.toHaveBeenCalled();
  });

  it("トピックとレポートパスを含む JSON を POST する", async () => {
    const f = vi.fn<FetchFn>(async () => ({ ok: true, status: 204 }));
    await createWebhookNotifier("https://hook", f).notifyHighRisk(items, "expertise/report.md");
    expect(f).toHaveBeenCalledOnce();
    const body = JSON.parse(f.mock.calls[0]?.[1].body ?? "{}") as { content: string };
    expect(body.content).toContain("ROS2 制御");
    expect(body.content).toContain("expertise/report.md");
  });

  it("非 2xx 応答は warn を残す(throw しない)", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() };
    const f = vi.fn<FetchFn>(async () => ({ ok: false, status: 403 }));
    await createWebhookNotifier("https://hook", f, logger).notifyHighRisk(
      items,
      "expertise/report.md",
    );
    expect(warn).toHaveBeenCalledWith("通知の投稿に失敗", { status: 403 });
  });

  it("fetch の例外は握りつぶして warn を残す", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() };
    const f = vi.fn<FetchFn>(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(
      createWebhookNotifier("https://hook", f, logger).notifyHighRisk(items, "expertise/report.md"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("通知の投稿に失敗", { error: "ENOTFOUND" });
  });
});
