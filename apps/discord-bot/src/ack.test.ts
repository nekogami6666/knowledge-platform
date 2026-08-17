import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  ACK_EMOJI,
  type AckMessage,
  ackReaction,
  DM_BLOCKED_NOTICE,
  type DmTarget,
  failureReason,
  noticeAllowedOnce,
  notifyUser,
  permanentFailureMessage,
  scrubSecrets,
  setNotifySecrets,
} from "./ack.js";
import { createMemoryStore } from "./db.js";

function fakeLogger(): { logger: Logger; warns: unknown[] } {
  const warns: unknown[] = [];
  const l = {
    child: () => l,
    error: () => {},
    warn: (obj: unknown) => {
      warns.push(obj);
    },
    info: () => {},
    debug: () => {},
  };
  return { logger: l as unknown as Logger, warns };
}

function fakeMessage(opts: { reactThrows?: boolean; replyThrows?: boolean } = {}): {
  message: AckMessage;
  reactions: string[];
  replies: string[];
} {
  const reactions: string[] = [];
  const replies: string[] = [];
  return {
    reactions,
    replies,
    message: {
      react: async (e: string) => {
        if (opts.reactThrows === true) throw new Error("Missing Permissions");
        reactions.push(e);
      },
      reply: async (c: string) => {
        if (opts.replyThrows === true) throw new Error("Missing Access");
        replies.push(c);
      },
    },
  };
}

function fakeUser(opts: { sendThrows?: boolean } = {}): { user: DmTarget; dms: string[] } {
  const dms: string[] = [];
  return {
    dms,
    user: {
      send: async (c: string) => {
        if (opts.sendThrows === true) throw new Error("Cannot send messages to this user");
        dms.push(c);
      },
    },
  };
}

describe("ackReaction (ADR-0030 D1)", () => {
  it("受理 ✅ / 保留 ⏳ / 見送り・失敗 ⚠️ を元メッセージに付ける", async () => {
    const { logger } = fakeLogger();
    const { message, reactions } = fakeMessage();
    await ackReaction(message, "accepted", logger);
    await ackReaction(message, "pending", logger);
    await ackReaction(message, "failed", logger);
    expect(reactions).toEqual([ACK_EMOJI.accepted, ACK_EMOJI.pending, ACK_EMOJI.failed]);
    expect(reactions).toEqual(["✅", "⏳", "⚠️"]);
  });

  it("react に失敗しても throw せず warn のみ(権限不足で本処理を落とさない)", async () => {
    const { logger, warns } = fakeLogger();
    const { message } = fakeMessage({ reactThrows: true });
    await expect(ackReaction(message, "accepted", logger)).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
  });
});

describe("notifyUser (ADR-0030 D2)", () => {
  it("DM が通れば DM だけを送る(元メッセージは汚さない)", async () => {
    const { logger } = fakeLogger();
    const { user, dms } = fakeUser();
    const { message, replies } = fakeMessage();
    await expect(notifyUser({ user, message }, "案内", logger)).resolves.toBe(true);
    expect(dms).toEqual(["案内"]);
    expect(replies).toEqual([]);
  });

  it("DM が閉じていれば元メッセージへのスレッド返信にフォールバックする", async () => {
    const { logger, warns } = fakeLogger();
    const { user, dms } = fakeUser({ sendThrows: true });
    const { message, replies } = fakeMessage();
    await expect(notifyUser({ user, message }, "案内", logger)).resolves.toBe(true);
    expect(dms).toEqual([]);
    expect(replies).toEqual(["案内"]);
    expect(warns).toHaveLength(1);
  });

  it("DM も返信も失敗したら false を返し warn のみ(throw しない)", async () => {
    const { logger, warns } = fakeLogger();
    const { user } = fakeUser({ sendThrows: true });
    const { message } = fakeMessage({ replyThrows: true });
    await expect(notifyUser({ user, message }, "案内", logger)).resolves.toBe(false);
    expect(warns).toHaveLength(2);
  });

  it("返信先が無い(VC 等)場合は DM 失敗で false を返す", async () => {
    const { logger } = fakeLogger();
    const { user } = fakeUser({ sendThrows: true });
    await expect(notifyUser({ user }, "案内", logger)).resolves.toBe(false);
  });

  it("DM 前提の文面は、返信に落ちるとき断り書きを先頭に付ける", async () => {
    const { logger } = fakeLogger();
    const { user } = fakeUser({ sendThrows: true });
    const { message, replies } = fakeMessage();
    await notifyUser({ user, message }, "この DM に 👍", logger, {
      fallbackPrefix: DM_BLOCKED_NOTICE,
    });
    expect(replies[0]).toBe(`${DM_BLOCKED_NOTICE}\nこの DM に 👍`);
  });
});

describe("failureReason / permanentFailureMessage (ADR-0030 D3)", () => {
  it("例外メッセージを 1 行に潰し、200 字で切る", () => {
    expect(failureReason(new Error("boom\n  詳細"))).toBe("boom 詳細");
    expect(failureReason("文字列 throw")).toBe("文字列 throw");
    const long = failureReason(new Error("あ".repeat(500)));
    expect(long).toHaveLength(201); // 200 字 + 省略記号
    expect(long.endsWith("…")).toBe(true);
  });

  it("メッセージが空でも「原因不明」を返す(無言にしない)", () => {
    expect(permanentFailureMessage(new Error(""))).toBe("処理できませんでした: 原因不明");
    expect(permanentFailureMessage(new Error("PR の作成に失敗"))).toBe(
      "処理できませんでした: PR の作成に失敗",
    );
  });
});

describe("noticeAllowedOnce (ADR-0030 D3/D4 の抑制)", () => {
  it("同じ (subject, kind, 日) では 1 回だけ true", () => {
    const store = createMemoryStore();
    expect(noticeAllowedOnce(store, "user:U1", "feature-off-notice:capture", "2026-08-13")).toBe(
      true,
    );
    expect(noticeAllowedOnce(store, "user:U1", "feature-off-notice:capture", "2026-08-13")).toBe(
      false,
    );
    // 別の人・別の機能・翌日は独立して 1 回通る。
    expect(noticeAllowedOnce(store, "user:U2", "feature-off-notice:capture", "2026-08-13")).toBe(
      true,
    );
    expect(noticeAllowedOnce(store, "user:U1", "feature-off-notice:voice", "2026-08-13")).toBe(
      true,
    );
    expect(noticeAllowedOnce(store, "user:U1", "feature-off-notice:capture", "2026-08-14")).toBe(
      true,
    );
  });
});

describe("scrubSecrets(ADR-0030・§9.1)", () => {
  it("通知本文から秘密値を伏字化する(例外メッセージ混入対策)", () => {
    expect(scrubSecrets("token=abc123 で失敗", ["abc123"])).toBe("token=[REDACTED] で失敗");
  });

  it("秘密値が無ければそのまま", () => {
    expect(scrubSecrets("普通のエラー", ["abc123"])).toBe("普通のエラー");
  });

  it("failureReason は秘密値を伏せた要約を返す", () => {
    setNotifySecrets(["sk-secret-value"]);
    expect(failureReason(new Error("call failed: sk-secret-value"))).toContain("[REDACTED]");
    expect(failureReason(new Error("call failed: sk-secret-value"))).not.toContain("sk-secret");
    setNotifySecrets([]);
  });
});
