import { describe, expect, it } from "vitest";
import {
  type DiscordState,
  readDiscordState,
  serializeDiscordState,
  snowflakeForDate,
} from "./state.js";

const sample: DiscordState = {
  version: 1,
  channels: {
    "222": { last_message_id: "9002", last_processed_at: "2026-08-21T00:00:00.000Z" },
    "111": { last_message_id: "9001", last_processed_at: "2026-08-21T00:00:00.000Z" },
  },
  last_run_at: "2026-08-21T00:00:00.000Z",
};

describe("readDiscordState / serializeDiscordState", () => {
  it("round-trip する", () => {
    const raw = serializeDiscordState(sample);
    expect(readDiscordState(raw)).toEqual(sample);
  });

  it("直列化はチャンネル ID 昇順 + 末尾改行で決定的", () => {
    const raw = serializeDiscordState(sample);
    expect(raw.indexOf('"111"')).toBeLessThan(raw.indexOf('"222"'));
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("不在(null)は初回として null", () => {
    expect(readDiscordState(null)).toBeNull();
  });

  it("壊れた JSON は warn して null(fail-loud にしない)", () => {
    const warns: string[] = [];
    const logger = {
      info: () => {},
      warn: (m: string) => {
        warns.push(m);
      },
      error: () => {},
    };
    expect(readDiscordState("{not json", logger)).toBeNull();
    expect(warns.length).toBe(1);
  });

  it("スキーマ不一致も warn して null", () => {
    const warns: string[] = [];
    const logger = {
      info: () => {},
      warn: (m: string) => {
        warns.push(m);
      },
      error: () => {},
    };
    expect(readDiscordState(JSON.stringify({ version: 2, channels: {} }), logger)).toBeNull();
    expect(warns.length).toBe(1);
  });
});

describe("snowflakeForDate", () => {
  it("Discord epoch 起点の ms を 22bit シフトした snowflake を返す", () => {
    // 2015-01-01T00:00:01Z = epoch + 1000ms → 1000 << 22
    expect(snowflakeForDate(new Date(1_420_070_401_000))).toBe((1000n << 22n).toString());
  });

  it("epoch 以前は 0 に丸める(負の snowflake を作らない)", () => {
    expect(snowflakeForDate(new Date(0))).toBe("0");
  });

  it("時刻の前後関係が snowflake の数値順に保存される", () => {
    const a = BigInt(snowflakeForDate(new Date("2026-05-01T00:00:00Z")));
    const b = BigInt(snowflakeForDate(new Date("2026-08-01T00:00:00Z")));
    expect(a < b).toBe(true);
  });
});
