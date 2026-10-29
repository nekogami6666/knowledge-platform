/**
 * System One の語の抽出と時間表現の解釈(ADR-0041 D1 / D3)。純関数(I/O・時計なし。「今」は注入)。
 *
 * - 語: NFKC + 小文字化した質問文から、漢字の連なり・カタカナの連なり・英数字の連なり(2 文字以上)と
 *   絵文字(💡 等。bot の操作名として文書に現れるため 1 文字でも語にする)を取り出す。
 *   ひらがな・記号・空白で区切る(助詞や「について」「教えて」は自然に落ちる)。漢字の連なりが 3 文字以上なら、
 *   表記ゆれ(「保守周期」と「保守の周期」等)を拾うため 2 文字ずつの部分語(bigram)を弱い重みで足す。
 * - 時間表現: 昨日・一昨日・今日・今週・先週・今月・先月・今年・去年・最近(30 日)・N月・N月N日・YYYY-MM-DD・M/D を
 *   JST の日付範囲(since / until。両端を含む YYYY-MM-DD)に変換する。時間表現の部分は語から外す。
 * embedding や形態素解析器は使わない(§5.4・依存を増やさない)。
 */

/** 抽出した語 1 つ。weight は 0〜1(長い・具体的な語ほど重い)。 */
export interface QueryTerm {
  /** 正規化済み(NFKC + 小文字)の語。 */
  text: string;
  weight: number;
  kind: "kanji" | "katakana" | "latin" | "bigram" | "symbol";
}

/** JST の日付範囲(両端を含む)。 */
export interface TimeWindow {
  /** YYYY-MM-DD。 */
  since: string;
  /** YYYY-MM-DD。 */
  until: string;
  /** 一致した表現(観測・テスト用)。 */
  matched: string[];
}

/** 照合用の正規化(全角英数 → 半角・半角カナ → 全角・英字は小文字)。カタログ側も同じ関数を使う。 */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * 語として使わない漢字・カタカナ語(質問の定型句・時間表現の残り)。ひらがなの語(こと・もの・について・
 * 教えて・どう 等)は抽出の時点で落ちるため載せない。
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "何",
  "最近",
  "直近",
  "最新",
  "現在",
  "今日",
  "本日",
  "昨日",
  "一昨日",
  "今週",
  "先週",
  "来週",
  "今月",
  "先月",
  "来月",
  "今年",
  "去年",
  "昨年",
  "来年",
  "今回",
  "前回",
  "以前",
  "内容",
  "詳細",
  "状況",
  "情報",
  "場合",
  "方法",
  "質問",
  "回答",
  "教",
  "誰",
  "何故",
  "以下",
  "以上",
  "関連",
  "全体",
  "具体的",
  "一覧",
  "ください",
]);

/** 語の連なり(漢字 / カタカナ / 英数字)。NFKC 後の文字列に当てる。 */
const TOKEN_RE =
  /[\p{Script=Han}々〆ヶ]+|[\p{Script=Katakana}ー]+|[a-z0-9]+(?:[._+#-][a-z0-9]+)*|\p{Extended_Pictographic}/gu;

function weightOf(kind: QueryTerm["kind"], text: string): number {
  const len = [...text].length;
  switch (kind) {
    case "kanji":
      return Math.min(1, 0.4 + 0.15 * len); // 2 文字 0.7・4 文字以上 1.0
    case "katakana":
      return len >= 4 ? 1 : 0.6;
    case "latin":
      if (/^\d+$/.test(text)) return 0.3; // 数字だけ(45 等)は多くの文書に現れるので弱く
      return len >= 4 ? 1 : 0.6;
    case "bigram":
      return 0.35;
    case "symbol":
      return 0.6; // 💡 等の絵文字は bot の操作名として文書に現れる(1 文字でも語にする)
  }
}

function kindOf(token: string): QueryTerm["kind"] {
  if (/^\p{Extended_Pictographic}$/u.test(token)) return "symbol";
  if (/^[\p{Script=Han}々〆ヶ]+$/u.test(token)) return "kanji";
  if (/^[\p{Script=Katakana}ー]+$/u.test(token)) return "katakana";
  return "latin";
}

/**
 * 質問文から語を抽出する(重複は除き、出現順)。時間表現を除いた本文から取る
 * (呼び出し側は parseTimeWindow の stripped を渡す。生の質問を渡しても動く)。
 */
export function extractTerms(text: string): QueryTerm[] {
  const norm = normalizeText(text);
  const out: QueryTerm[] = [];
  const seen = new Set<string>();
  const push = (t: QueryTerm): void => {
    if (seen.has(t.text) || STOPWORDS.has(t.text)) return;
    seen.add(t.text);
    out.push(t);
  };
  for (const m of norm.matchAll(TOKEN_RE)) {
    const token = m[0];
    const chars = [...token];
    const kind = kindOf(token);
    if (chars.length < 2 && kind !== "symbol") continue;
    if (/^ー+$/.test(token)) continue;
    push({ text: token, weight: weightOf(kind, token), kind });
    if (kind === "kanji" && chars.length >= 3) {
      for (let i = 0; i + 2 <= chars.length; i += 1) {
        const bi = chars.slice(i, i + 2).join("");
        push({ text: bi, weight: weightOf("bigram", bi), kind: "bigram" });
      }
    }
  }
  return out;
}

// --- 時間表現 ---

const DAY_MS = 86_400_000;

/** epoch ms → JST の暦日(年・月・日・曜日)。 */
function jstParts(ms: number): { y: number; m: number; d: number; dow: number } {
  const t = new Date(ms + 9 * 3_600_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

/** JST の暦日 → 日番号(UTC の日数。差分計算用)。 */
function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fmtDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** 妥当な暦日か(2/30 等を弾く)。 */
function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

interface Span {
  since: number;
  until: number;
  start: number;
  end: number;
  text: string;
}

/**
 * 質問文の時間表現を JST の日付範囲にする。複数あれば全体を覆う範囲にする。
 * 年の無い「N月」「M/D」は、今より未来になるなら前年と解釈する(過去の記録を聞く質問が大半のため)。
 * 戻りの stripped は時間表現を空白に置き換えた正規化済み文字列(語の抽出に使う)。
 */
export function parseTimeWindow(
  question: string,
  nowMs: number,
): { window: TimeWindow | null; stripped: string } {
  const norm = normalizeText(question);
  const now = jstParts(nowMs);
  const today = dayNumber(now.y, now.m, now.d);
  const spans: Span[] = [];
  const taken: boolean[] = new Array(norm.length).fill(false);
  const add = (re: RegExp, toRange: (m: RegExpExecArray) => [number, number] | null): void => {
    for (const m of norm.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.slice(start, end).some(Boolean)) continue;
      const r = toRange(m as RegExpExecArray);
      if (r === null) continue;
      for (let i = start; i < end; i += 1) taken[i] = true;
      spans.push({ since: r[0], until: r[1], start, end, text: m[0] });
    }
  };
  const inferYear = (m: number, d: number): number => {
    const y = now.y;
    return dayNumber(y, m, d) > today ? y - 1 : y;
  };
  // 具体的な表現から順に当てる(後の短い表現が前の一部に重ならないよう taken で除外)。
  add(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/g, (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDate(y, mo, d)) return null;
    const n = dayNumber(y, mo, d);
    return [n, n];
  });
  add(/(\d{4})年(\d{1,2})月/g, (m) => {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12) return null;
    return [dayNumber(y, mo, 1), dayNumber(y, mo, lastDayOfMonth(y, mo))];
  });
  add(/(\d{1,2})月(\d{1,2})日/g, (m) => {
    const [mo, d] = [Number(m[1]), Number(m[2])];
    const y = validDate(now.y, mo, d) ? inferYear(mo, d) : now.y - 1;
    if (!validDate(y, mo, d)) return null;
    const n = dayNumber(y, mo, d);
    return [n, n];
  });
  add(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, (m) => {
    const [mo, d] = [Number(m[1]), Number(m[2])];
    const y = validDate(now.y, mo, d) ? inferYear(mo, d) : now.y - 1;
    if (!validDate(y, mo, d)) return null;
    const n = dayNumber(y, mo, d);
    return [n, n];
  });
  add(/(?<!\d)(\d{1,2})月/g, (m) => {
    const mo = Number(m[1]);
    if (mo < 1 || mo > 12) return null;
    const y = mo > now.m ? now.y - 1 : now.y;
    return [dayNumber(y, mo, 1), dayNumber(y, mo, lastDayOfMonth(y, mo))];
  });
  add(/一昨日|おととい/g, () => [today - 2, today - 2]);
  add(/昨日|きのう/g, () => [today - 1, today - 1]);
  add(/今日|本日|きょう/g, () => [today, today]);
  // 週は月曜始まり。
  const monday = today - ((now.dow + 6) % 7);
  add(/今週/g, () => [monday, today]);
  add(/先週/g, () => [monday - 7, monday - 1]);
  add(/今月/g, () => [dayNumber(now.y, now.m, 1), today]);
  add(/先月/g, () => {
    const y = now.m === 1 ? now.y - 1 : now.y;
    const mo = now.m === 1 ? 12 : now.m - 1;
    return [dayNumber(y, mo, 1), dayNumber(y, mo, lastDayOfMonth(y, mo))];
  });
  add(/今年/g, () => [dayNumber(now.y, 1, 1), today]);
  add(/去年|昨年/g, () => [dayNumber(now.y - 1, 1, 1), dayNumber(now.y - 1, 12, 31)]);
  add(/最近|直近|このところ/g, () => [today - 30, today]);

  let stripped = "";
  for (let i = 0; i < norm.length; i += 1) stripped += taken[i] ? " " : norm[i];
  if (spans.length === 0) return { window: null, stripped };
  spans.sort((a, b) => a.start - b.start);
  return {
    window: {
      since: fmtDay(Math.min(...spans.map((s) => s.since))),
      until: fmtDay(Math.max(...spans.map((s) => s.until))),
      matched: spans.map((s) => s.text),
    },
    stripped,
  };
}

/** 「時間に依存する質問」の手がかり語(timeSensitive の特徴量)。 */
// ひらがなの短い語(いま・まだ 等)は「います」「ますか」に誤一致するため入れない。
const TIME_WORDS_RE = /最新|最近|直近|現在|今の|今後|いつ|進捗|状況|予定|最終|現状|変更後|その後/g;

/** 「コードを読む必要がある」手がかり語(needsCode の特徴量)。NFKC + 小文字化した文字列に当てる。 */
const CODE_WORDS_RE =
  /実装|コード|関数|メソッド|クラス|ソース|リポジトリ|リポ|ブランチ|ビルド|デプロイ|設定ファイル|環境変数|ライブラリ|変数|引数|例外|スタックトレース|コンパイル|api|sdk|cli|\bpr\b|issue|commit|コミット|テスト|型定義|スキーマ|エンドポイント/g;

/** 識別子らしい語(camelCase・snake_case・拡張子付きのファイル名・関数呼び出し)。生の質問文に当てる。 */
const IDENTIFIER_RE =
  /[a-z][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]|\.(ts|js|py|c|h|cpp|rs|go|yaml|yml|json|md|toml)\b|\w\(\)/;

/** 質問全体の特徴量(decide の yes/no 判定に使う)。 */
export interface QuestionSignals {
  /** 時間の手がかり語の数(0〜1 に丸めて使う)。 */
  timeWords: number;
  /** コードの手がかり語の数(0〜1 に丸めて使う)。 */
  codeWords: number;
  /** 識別子らしい語があるか(0/1)。 */
  identifierLike: number;
}

export function questionSignals(question: string): QuestionSignals {
  const norm = normalizeText(question);
  const count = (re: RegExp): number => [...norm.matchAll(re)].length;
  return {
    timeWords: Math.min(1, count(TIME_WORDS_RE) / 2),
    codeWords: Math.min(1, count(CODE_WORDS_RE) / 2),
    identifierLike: IDENTIFIER_RE.test(question.normalize("NFKC")) ? 1 : 0,
  };
}
