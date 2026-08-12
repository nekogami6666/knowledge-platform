/**
 * 議事録の「参加者:」行の解析と人物名の正規化(ADR-0027 D1)。
 * 旧 run.ts の parseParticipants は空白で氏名を分割し(`Shoma Nagata` → `Shoma`+`Nagata`)、
 * 記号・録音 bot・番号・括弧注記が「人物」として deciders/owner に混入していた(KP issue #104)。
 * ここでは区切りを `,`・`、`・`/` に限定して氏名内の空白を保持し、非人物トークンを機械的に除外、
 * members.yaml(kb-core parseMembers)との照合で GitHub ユーザ名へ正規化する(§4.2)。
 * 一致しない名前は生のまま保持する(外部出席者を消さない)。
 */
import type { Member } from "@stratum/kb-core";

export interface ParseParticipantsOptions {
  /** 除外する非人物名(録音 bot 等。大文字小文字無視・完全一致。extractor.yaml participants_exclude)。 */
  exclude?: readonly string[];
  /** 名前の正規化(members.yaml 照合)。解決できれば正規化名、null なら生の名前を保持する。 */
  resolve?: (raw: string) => string | null;
}

/** 括弧注記(半角・全角)を除去する。`Pascal Pama (Paco)` → `Pascal Pama`。 */
function stripParenthetical(token: string): string {
  return token.replace(/[((][^))]*[))]/g, " ").trim();
}

/** 連続空白を 1 つに畳む(注記除去などで生じた隙間の整形。氏名内の空白自体は保持)。 */
function collapseSpaces(token: string): string {
  return token.replace(/\s+/g, " ").trim();
}

/** 人物名として妥当か。空・数字のみ・記号のみ(文字を含まない)・1文字は除外する。 */
function isPlausibleName(token: string): boolean {
  if (token.length === 0) return false;
  if (!/\p{L}/u.test(token)) return false; // 数字のみ・記号のみ(`02`・`/` 等)
  if ([...token].length < 2) return false; // 1文字トークン
  return true;
}

/**
 * exclude 判定(大文字小文字無視)。トークン全体の完全一致に加え、空白区切りの全語が exclude に
 * 載る場合も除外する(`QB Recorder` のように bot 名が 1 トークンに連結されるケース・ADR-0027 検証1)。
 */
function isExcluded(token: string, excludeLower: ReadonlySet<string>): boolean {
  if (excludeLower.size === 0) return false;
  const lower = token.toLowerCase();
  if (excludeLower.has(lower)) return true;
  const words = lower.split(/\s+/).filter((w) => w.length > 0);
  return words.length > 0 && words.every((w) => excludeLower.has(w));
}

/**
 * 議事録の「参加者: a, b」行から参加者を抽出する(owner/deciders のフォールバック用)。
 * 区切りは `,`・`、`・`/` のみ(氏名内の空白は保持・ADR-0027 D1)。
 */
export function parseParticipants(content: string, opts?: ParseParticipantsOptions): string[] {
  const m = /(?:参加者|participants?)\s*[:：]\s*(.+)/i.exec(content);
  if (m?.[1] === undefined) return [];
  const excludeLower = new Set((opts?.exclude ?? []).map((e) => e.trim().toLowerCase()));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawToken of m[1].split(/[,、/]/)) {
    const token = collapseSpaces(stripParenthetical(rawToken.trim()));
    if (!isPlausibleName(token)) continue;
    if (isExcluded(token, excludeLower)) continue;
    const resolved = opts?.resolve?.(token) ?? null;
    const name = resolved ?? token; // 解決不能は生名保持(外部出席者を消さない)
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * members.yaml から名前リゾルバを作る。名前系のキー(name / github / github_alts)と
 * 大小無視・trim 一致すれば GitHub ユーザ名(§4.2 の正)を返す(discord / discord_alts は
 * snowflake ID であり議事録の名前とは照合しない)。github を持たない member は
 * null(= 呼び出し側が生名を保持)。
 */
export function buildNameResolver(members: readonly Member[]): (raw: string) => string | null {
  const index = new Map<string, string | null>();
  for (const m of members) {
    const keys = [m.name, m.github, ...(m.github_alts ?? [])];
    for (const k of keys) {
      if (k === undefined) continue;
      const norm = k.trim().toLowerCase();
      if (norm.length === 0 || index.has(norm)) continue;
      index.set(norm, m.github ?? null);
    }
  }
  return (raw) => index.get(raw.trim().toLowerCase()) ?? null;
}
