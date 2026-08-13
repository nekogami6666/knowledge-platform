import { describe, expect, it } from "vitest";
import {
  interviewProtectedMeetingIds,
  planRecordingsCleanup,
  type RecordingDirInfo,
} from "./recordings-cleanup.js";

const NOW = new Date("2026-07-27T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** 指定日数前に開始・最終更新された録音ディレクトリ。 */
function dir(name: string, daysAgo: number, extra?: Partial<RecordingDirInfo>): RecordingDirInfo {
  const at = NOW.getTime() - daysAgo * DAY;
  return { name, mtimeMs: at, hasTmp: false, ...extra };
}

function vmName(daysAgo: number, channel = "1530111568547942440"): string {
  return `vm-${NOW.getTime() - daysAgo * DAY}-${channel}`;
}

const base = { now: NOW, retentionDays: 14, tmpRetentionDays: 3 };

describe("planRecordingsCleanup", () => {
  it("保持期限を過ぎたディレクトリを削除対象にする", () => {
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [dir(vmName(20), 20), dir(vmName(5), 5)],
      pendingMeetingIds: new Set(),
    });
    expect(plan.removeDirs).toEqual([vmName(20)]);
    expect(plan.removeTmpOnly).toEqual([]);
  });

  it("期限内でも tmp/(生 PCM)は先に削除する", () => {
    const name = vmName(5);
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [dir(name, 5, { hasTmp: true })],
      pendingMeetingIds: new Set(),
    });
    expect(plan.removeDirs).toEqual([]);
    expect(plan.removeTmpOnly).toEqual([name]);
  });

  it("tmp/ が新しければ残す", () => {
    const name = vmName(5);
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [dir(name, 5, { hasTmp: true, tmpMtimeMs: NOW.getTime() - 1 * DAY })],
      pendingMeetingIds: new Set(),
    });
    expect(plan.removeTmpOnly).toEqual([]);
  });

  it("pending の meetingId は年齢に関わらず残す(処理待ちの音声を失わない)", () => {
    const old = vmName(90);
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [dir(old, 90, { hasTmp: true })],
      pendingMeetingIds: new Set([old]),
    });
    expect(plan.removeDirs).toEqual([]);
    expect(plan.removeTmpOnly).toEqual([]);
    expect(plan.keptPending).toEqual([old]);
  });

  it("想定外の名前は触らない(ホワイトリスト方式)", () => {
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [dir("scratch", 99), dir("vm-notanumber-123", 99), dir("vm-123", 99)],
      pendingMeetingIds: new Set(),
    });
    expect(plan.removeDirs).toEqual([]);
    expect(plan.ignored).toEqual(["scratch", "vm-notanumber-123", "vm-123"]);
  });

  it("mtime が新しければ古い名前でも残す(finalize 遅延を尊重)", () => {
    const name = vmName(30);
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [{ name, mtimeMs: NOW.getTime() - 1 * DAY, hasTmp: false }],
      pendingMeetingIds: new Set(),
    });
    expect(plan.removeDirs).toEqual([]);
  });

  it("録音直後(数分前)は当然残す", () => {
    const at = NOW.getTime() - 5 * 60 * 1000;
    const name = `vm-${at}-1530111568547942440`;
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [{ name, mtimeMs: at, hasTmp: true, tmpMtimeMs: at }],
      pendingMeetingIds: new Set(),
    });
    expect(plan.removeDirs).toEqual([]);
    expect(plan.removeTmpOnly).toEqual([]);
  });
});

describe("interviewProtectedMeetingIds(ADR-0028 D2 の保護集合)", () => {
  const payload = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      sessionId: "s",
      chunks: [
        { seq: 1, meetingId: "vm-c1" },
        { seq: 2, meetingId: "vm-c2" },
      ],
      currentChunk: { seq: 3, meetingId: "vm-cur" },
      ...over,
    });

  it("done / cancelled 以外(armed / recording / pending)の chunks + currentChunk を集める", () => {
    for (const state of ["armed", "recording", "pending"]) {
      const ids = interviewProtectedMeetingIds([{ state, payloadJson: payload() }]);
      expect([...ids].sort()).toEqual(["vm-c1", "vm-c2", "vm-cur"]);
    }
  });

  it("done / cancelled は保護しない(retention に任せて消せる)", () => {
    expect(
      interviewProtectedMeetingIds([
        { state: "done", payloadJson: payload() },
        { state: "cancelled", payloadJson: payload() },
      ]).size,
    ).toBe(0);
  });

  it("currentChunk 無し(null)・壊れた JSON・null payload は無視する", () => {
    const ids = interviewProtectedMeetingIds([
      { state: "recording", payloadJson: payload({ currentChunk: null }) },
      { state: "recording", payloadJson: "{broken" },
      { state: "recording", payloadJson: null },
    ]);
    expect([...ids].sort()).toEqual(["vm-c1", "vm-c2"]);
  });

  it("planRecordingsCleanup と組み合わせて年齢超過でも残す", () => {
    const old = vmName(90);
    const ids = interviewProtectedMeetingIds([
      {
        state: "recording",
        payloadJson: JSON.stringify({ chunks: [{ seq: 1, meetingId: old }], currentChunk: null }),
      },
    ]);
    const plan = planRecordingsCleanup({
      ...base,
      dirs: [dir(old, 90)],
      pendingMeetingIds: ids,
    });
    expect(plan.removeDirs).toEqual([]);
    expect(plan.keptPending).toEqual([old]);
  });
});
