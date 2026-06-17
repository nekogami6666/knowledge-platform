import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

/** pino の出力を1行ずつ捕捉する書き込み先(DestinationStream 互換)。 */
function capture(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => lines.push(s) };
}

describe("createLogger redact (§9.1 シークレット非ログ)", () => {
  it("token / api key を [REDACTED] にし、生値はログに出さない", () => {
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
});
