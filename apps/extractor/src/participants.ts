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
 * members.yaml から名前リゾルバを作る(ADR-0027 D1 / ADR-0031 D2・D5)。
 * - キー: name / github / github_alts / **aliases**(漢字姓等の別表記・kb-core-v6)。
 *   大小無視・trim 完全一致。discord / discord_alts は snowflake ID なので照合しない。
 * - 戻り値の正規名: `github ?? name`(D2。github 未所持でも members に載っていれば name に揃う)。
 *   どちらも無い member は解決対象外。
 * - 補助(D5): name / aliases の空白区切りトークンのうち**全メンバーで一意なもの**だけを
 *   完全一致キーに加える(「Nagata」→ Shoma Nagata)。衝突したトークンは索引に入れない
 *   (解決しない = 生名保持で安全側)。**前方一致・「最終トークン=姓」の推測は恒久禁止**
 *   (Nagai/Nagata・Matsumoto/Matsuhashi で衝突、Yoshikawa Hiroshi は姓が先頭で誤爆する)。
 */
export function buildNameResolver(members: readonly Member[]): (raw: string) => string | null {
  const index = new Map<string, string>();
  const add = (key: string | undefined, canonical: string): void => {
    if (key === undefined) return;
    const norm = key.trim().toLowerCase();
    if (norm.length === 0 || index.has(norm)) return;
    index.set(norm, canonical);
  };
  const canonicalOf = (m: Member): string | undefined => m.github ?? m.name;
  for (const m of members) {
    const canonical = canonicalOf(m);
    if (canonical === undefined) continue;
    for (const k of [m.name, m.github, ...(m.github_alts ?? []), ...(m.aliases ?? [])]) {
      add(k, canonical);
    }
  }
  // 一意トークン索引(D5)。衝突は null マークして解決対象から外す。
  const tokenOwner = new Map<string, string | null>();
  for (const m of members) {
    const canonical = canonicalOf(m);
    if (canonical === undefined) continue;
    for (const source of [m.name, ...(m.aliases ?? [])]) {
      if (source === undefined) continue;
      for (const t of source.split(/\s+/)) {
        const norm = t.trim().toLowerCase();
        if ([...norm].length < 2) continue; // 1 文字トークンは曖昧
        const existing = tokenOwner.get(norm);
        if (existing === undefined) tokenOwner.set(norm, canonical);
        else if (existing !== canonical) tokenOwner.set(norm, null); // 同名トークン衝突 → 無効化
      }
    }
  }
  for (const [token, canonical] of tokenOwner) {
    if (canonical !== null && !index.has(token)) index.set(token, canonical);
  }
  return (raw) => index.get(raw.trim().toLowerCase()) ?? null;
}

/**
 * LLM 出力の人名リストを正規化する(ADR-0031 D3)。解決できれば正規名、できなければ生名保持
 * (外部出席者を消さない)。正規化後の重複(「宗石」と「Yoshimasa Muneishi」の併記等)は畳む。
 */
export function resolvePeople(
  names: readonly string[],
  resolve: ((raw: string) => string | null) | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = resolve?.(raw) ?? raw;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
