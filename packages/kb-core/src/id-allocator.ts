import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KbIdError } from "./errors.js";

/**
 * エントリ ID 採番(design.md §4.2, §6.1)。
 *
 * `_meta/id-counter.json` を介し、kind→年→連番 のネスト構造で採番する。
 * 同時実行は GitHub の compare-and-swap 的リトライで解決する想定のため、ストアは
 * version トークン付き CAS インターフェースとして抽象化し、gh-client 結合時に
 * GitHub Contents API の file SHA を version として差し込めるようにしてある。
 * 本パッケージではローカル fs 実装までを提供する。
 */

export type IdKind = "kb" | "dr" | "q";

/** `_meta/id-counter.json` の構造。{ kind: { 年(文字列): 連番 } }。 */
export interface IdCounterFile {
  [kind: string]: { [year: string]: number };
}

export interface IdCounterStore {
  /** 現在のカウンタと version トークンを返す。未初期化なら counters={}, version=null。 */
  load(): Promise<{ counters: IdCounterFile; version: string | null }>;
  /** expectedVersion が現在の version と一致する場合のみ保存。競合時は throw。 */
  save(counters: IdCounterFile, expectedVersion: string | null): Promise<void>;
}

const MAX_SEQ = 9999;

/** JST(+09:00)基準の年を返す(design.md §7.5)。 */
function jstYear(now: Date): string {
  return String(new Date(now.getTime() + 9 * 3600 * 1000).getUTCFullYear());
}

function formatId(kind: IdKind, year: string, seq: number): string {
  return `${kind}-${year}-${String(seq).padStart(4, "0")}`;
}

export interface AllocateIdOptions {
  /** 年の決定に使う現在時刻(テスト用に注入可能)。 */
  now?: Date;
  /** CAS 競合時のリトライ上限(既定 5)。 */
  maxRetries?: number;
}

/**
 * 次の ID を採番する。CAS 競合時は load からやり直し、上限到達で {@link KbIdError} を投げる。
 */
export async function allocateId(
  kind: IdKind,
  store: IdCounterStore,
  options: AllocateIdOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const year = jstYear(now);
  const maxRetries = options.maxRetries ?? 5;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { counters, version } = await store.load();
    const current = counters[kind]?.[year] ?? 0;
    if (!Number.isInteger(current) || current < 0) {
      throw new KbIdError("CORRUPT_COUNTER", `カウンタ値が不正です: ${kind}/${year}=${current}`);
    }
    const next = current + 1;
    if (next > MAX_SEQ) {
      throw new KbIdError("OVERFLOW", `${kind}-${year} の連番が上限(${MAX_SEQ})に達しました`);
    }
    const updated: IdCounterFile = {
      ...counters,
      [kind]: { ...(counters[kind] ?? {}), [year]: next },
    };
    try {
      await store.save(updated, version);
      return formatId(kind, year, next);
    } catch (error) {
      // CAS 競合のみリトライ対象。実 I/O エラー(EACCES・API 401/404 等)は透過させる。
      if (!(error instanceof IdCounterConflictError)) throw error;
      if (attempt === maxRetries) {
        throw new KbIdError(
          "CONFLICT",
          `ID 採番が ${maxRetries} 回のリトライ後も競合しました: ${kind}-${year}`,
          { cause: error },
        );
      }
      // 競合 → ループ先頭で再 load してリトライ
    }
  }
  // 到達不能(ループは return か throw で抜ける)
  throw new KbIdError("CONFLICT", `ID 採番に失敗しました: ${kind}-${year}`);
}

/** CAS 競合を表す番兵エラー(ローカル/GitHub 実装が save で投げる)。 */
export class IdCounterConflictError extends Error {
  readonly name = "IdCounterConflictError";
}

/**
 * `_meta/id-counter.json` を読み書きするローカル fs 実装。
 * version にはファイル内容そのものを用い、save 時に現在内容が expectedVersion と
 * 異なれば競合として扱う(楽観的ロックの簡易版)。
 */
export function createLocalIdCounterStore(repoRoot: string): IdCounterStore {
  const filePath = join(repoRoot, "_meta", "id-counter.json");

  async function readRaw(): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    async load() {
      const raw = await readRaw();
      if (raw === null) return { counters: {}, version: null };
      try {
        return { counters: JSON.parse(raw) as IdCounterFile, version: raw };
      } catch (cause) {
        throw new KbIdError("CORRUPT_COUNTER", `${filePath} の JSON が壊れています`, { cause });
      }
    },
    async save(counters, expectedVersion) {
      const current = await readRaw();
      if (current !== expectedVersion) {
        throw new IdCounterConflictError(`${filePath} が他者により更新されています`);
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(counters, null, 2)}\n`, "utf8");
    },
  };
}
