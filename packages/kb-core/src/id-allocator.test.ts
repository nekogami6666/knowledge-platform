import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KbIdError } from "./errors.js";
import {
  allocateId,
  createLocalIdCounterStore,
  IdCounterConflictError,
  type IdCounterFile,
  type IdCounterStore,
} from "./id-allocator.js";

/** version トークン付きの簡易インメモリ CAS ストア。 */
function memStore(initial: IdCounterFile = {}): IdCounterStore {
  let counters = structuredClone(initial);
  let version: string | null = Object.keys(initial).length > 0 ? "v0" : null;
  let seq = 0;
  return {
    async load() {
      return { counters: structuredClone(counters), version };
    },
    async save(next, expectedVersion) {
      if (expectedVersion !== version) throw new IdCounterConflictError("version mismatch");
      counters = structuredClone(next);
      version = `v${++seq + 1}`;
    },
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("allocateId", () => {
  const now = new Date("2026-06-10T00:00:00+09:00");

  it("初回は連番 0001 を採番する", async () => {
    expect(await allocateId("kb", memStore(), { now })).toBe("kb-2026-0001");
  });

  it("呼ぶたびにインクリメントする", async () => {
    const store = memStore();
    expect(await allocateId("kb", store, { now })).toBe("kb-2026-0001");
    expect(await allocateId("kb", store, { now })).toBe("kb-2026-0002");
  });

  it("kind ごとに独立したカウンタを持つ", async () => {
    const store = memStore();
    expect(await allocateId("kb", store, { now })).toBe("kb-2026-0001");
    expect(await allocateId("dr", store, { now })).toBe("dr-2026-0001");
    expect(await allocateId("q", store, { now })).toBe("q-2026-0001");
  });

  it("年が変わると連番がリセットされる", async () => {
    const store = memStore({ kb: { "2026": 5 } });
    expect(await allocateId("kb", store, { now: new Date("2027-01-15T00:00:00+09:00") })).toBe(
      "kb-2027-0001",
    );
  });

  it("JST 基準で年を決める(UTC 22:00 は翌日 JST)", async () => {
    const store = memStore();
    // 2026-12-31T20:00:00Z = 2027-01-01T05:00:00+09:00
    expect(await allocateId("kb", store, { now: new Date("2026-12-31T20:00:00Z") })).toBe(
      "kb-2027-0001",
    );
  });

  it("4 桁の上限(9999)を超えると OVERFLOW", async () => {
    const store = memStore({ kb: { "2026": 9999 } });
    await expect(allocateId("kb", store, { now })).rejects.toMatchObject({
      name: "KbIdError",
      code: "OVERFLOW",
    });
  });

  it("カウンタ値が破損していると CORRUPT_COUNTER", async () => {
    const store = memStore({ kb: { "2026": -3 } });
    await expect(allocateId("kb", store, { now })).rejects.toMatchObject({
      code: "CORRUPT_COUNTER",
    });
  });

  it("CAS 競合は再 load してリトライし、最終的に成功する", async () => {
    const inner = memStore();
    let failsLeft = 2;
    const flaky: IdCounterStore = {
      load: () => inner.load(),
      async save(next, expected) {
        if (failsLeft > 0) {
          failsLeft--;
          throw new IdCounterConflictError("conflict");
        }
        return inner.save(next, expected);
      },
    };
    expect(await allocateId("kb", flaky, { now, maxRetries: 5 })).toBe("kb-2026-0001");
  });

  it("CAS 競合でない I/O エラーは握りつぶさず透過する", async () => {
    const inner = memStore();
    const ioError = new Error("EACCES");
    const failing: IdCounterStore = {
      load: () => inner.load(),
      async save() {
        throw ioError;
      },
    };
    await expect(allocateId("kb", failing, { now })).rejects.toBe(ioError);
  });

  it("リトライ上限を超える競合は CONFLICT", async () => {
    const inner = memStore();
    const alwaysConflict: IdCounterStore = {
      load: () => inner.load(),
      async save() {
        throw new IdCounterConflictError("conflict");
      },
    };
    await expect(allocateId("kb", alwaysConflict, { now, maxRetries: 2 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("createLocalIdCounterStore", () => {
  async function freshRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kb-core-id-"));
    tmpDirs.push(dir);
    return dir;
  }

  const now = new Date("2026-06-10T00:00:00+09:00");

  it("カウンタファイル不在からでも採番でき、ファイルを生成する", async () => {
    const repo = await freshRepo();
    const store = createLocalIdCounterStore(repo);
    expect(await allocateId("kb", store, { now })).toBe("kb-2026-0001");
    const raw = await readFile(join(repo, "_meta", "id-counter.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ kb: { "2026": 1 } });
  });

  it("連続採番が永続化される", async () => {
    const repo = await freshRepo();
    const store = createLocalIdCounterStore(repo);
    await allocateId("kb", store, { now });
    expect(await allocateId("kb", store, { now })).toBe("kb-2026-0002");
    // 別ストアインスタンスでも継続する
    expect(await allocateId("kb", createLocalIdCounterStore(repo), { now })).toBe("kb-2026-0003");
  });

  it("壊れた JSON は CORRUPT_COUNTER", async () => {
    const repo = await freshRepo();
    const store = createLocalIdCounterStore(repo);
    await allocateId("kb", store, { now }); // ファイル生成
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repo, "_meta", "id-counter.json"), "{ not json", "utf8");
    await expect(allocateId("kb", store, { now })).rejects.toMatchObject({
      code: "CORRUPT_COUNTER",
    });
  });
});
