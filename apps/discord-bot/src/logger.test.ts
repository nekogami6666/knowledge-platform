import { describe, expect, it } from "vitest";
import { createLogger, scrubDiscordUrlTokens } from "./logger.js";

/** pino の出力を1行ずつ捕捉する書き込み先(DestinationStream 互換)。 */
function capture(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => lines.push(s) };
}

describe("createLogger redact (§9.1 シークレット非ログ)", () => {
  it("(B)既知キーをトップ/ネスト/err.config で [REDACTED] にする", () => {
    const sink = capture();
    const logger = createLogger("info", { write: sink.write });
    logger.info(
      {
        DISCORD_TOKEN: "raw-discord-secret",
        nested: { ANTHROPIC_AWS_API_KEY: "raw-anthropic-secret" },
        err: { config: { DISCORD_TOKEN: "raw-in-err" } },
      },
      "secret check",
    );
    const out = sink.lines.join("\n");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("raw-discord-secret");
    expect(out).not.toContain("raw-anthropic-secret");
    expect(out).not.toContain("raw-in-err");
  });

  it("(B)2階層以上の深いネストでも秘密キーを伏字化する", () => {
    const sink = capture();
    const logger = createLogger("info", { write: sink.write });
    logger.info({ a: { b: { ANTHROPIC_AWS_API_KEY: "raw-deep" } } }, "deep");
    expect(sink.lines.join("\n")).not.toContain("raw-deep");
  });

  it("(B)配列要素の中の秘密キーも伏字化する", () => {
    const sink = capture();
    const logger = createLogger("info", { write: sink.write });
    logger.info({ items: [{ DISCORD_TOKEN: "raw-arr" }] }, "array");
    expect(sink.lines.join("\n")).not.toContain("raw-arr");
  });

  it("(A)err.message に混入した秘密「値」を文字列スクラブで消す", () => {
    const sink = capture();
    const logger = createLogger("info", { write: sink.write }, ["raw-anthropic-in-msg"]);
    // serializers.err が message/stack を整形 → (A) が最終行から値を消す。
    logger.error({ err: new Error("auth failed token=raw-anthropic-in-msg") }, "err with secret");
    const out = sink.lines.join("\n");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("raw-anthropic-in-msg");
  });

  it("(A)秘密値が任意の文字列(msg 等)に出ても消す", () => {
    const sink = capture();
    const logger = createLogger("info", { write: sink.write }, ["sk-ant-xyz"]);
    logger.info({ note: "leaked sk-ant-xyz here" }, "msg sk-ant-xyz");
    const out = sink.lines.join("\n");
    expect(out).not.toContain("sk-ant-xyz");
  });
});

describe("(C) Discord の webhook / interaction URL の token を伏字化(2026-10-01)", () => {
  const TOKEN = "aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDpBQkNERUZHSElKS0xNTk9Q_x-y.z";

  it("DiscordAPIError の url・message に載った interaction token を伏せ、ID は残す", () => {
    const sink = capture();
    const logger = createLogger("info", { write: sink.write });
    const err = Object.assign(
      new Error(`Unknown Message: /webhooks/1234567890/${TOKEN}/messages/@original`),
      {
        url: `https://discord.com/api/v10/webhooks/1234567890/${TOKEN}/messages/@original`,
      },
    );
    logger.warn(
      { err, other: `https://discord.com/api/v10/interactions/987654321/${TOKEN}/callback` },
      "x",
    );
    const out = sink.lines.join("\n");
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("/webhooks/1234567890/[REDACTED]/messages/@original");
    expect(out).toContain("/interactions/987654321/[REDACTED]/callback");
  });

  it("短い値やチャンネルの permalink(guild/channel/message の ID)は変えない", () => {
    expect(scrubDiscordUrlTokens("https://discord.com/channels/1/2/3")).toBe(
      "https://discord.com/channels/1/2/3",
    );
    expect(scrubDiscordUrlTokens("/webhooks/123/short")).toBe("/webhooks/123/short");
  });
});
