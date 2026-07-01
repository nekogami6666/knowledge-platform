import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("秘密の実値を [REDACTED] にスクラブ(msg / data 両方)", () => {
    const lines: string[] = [];
    const log = createLogger(["sk-secret"], (l) => lines.push(l));
    log.info("token=sk-secret", { key: "sk-secret", ok: 1 });
    const out = lines.join("");
    expect(out).not.toContain("sk-secret");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain('"level":"info"');
  });
  it("空の秘密値は無視して通常出力", () => {
    const lines: string[] = [];
    const log = createLogger([""], (l) => lines.push(l));
    log.warn("hello");
    expect(lines.join("")).toContain("hello");
  });
});
