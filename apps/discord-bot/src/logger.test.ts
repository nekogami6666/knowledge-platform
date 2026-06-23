import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

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
        nested: { ANTHROPIC_API_KEY: "raw-anthropic-secret" },
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
    logger.info({ a: { b: { ANTHROPIC_API_KEY: "raw-deep" } } }, "deep");
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
