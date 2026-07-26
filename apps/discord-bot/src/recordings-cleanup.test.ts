import { describe, expect, it } from "vitest";
import { planRecordingsCleanup, type RecordingDirInfo } from "./recordings-cleanup.js";

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
