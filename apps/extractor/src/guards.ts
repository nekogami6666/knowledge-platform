/**
 * 抽出候補の機械ガード層(ADR-0027 D2)。LLM のプロンプト遵守は確率的でテスト不能なため、
 * 未確定表現・安全語彙・曖昧レンジをコード側で決定的に検査する(回帰を必須テストで固定)。
 * extract 直後・reconcile 前に適用する(降格された decision は reconcile の LLM コストを使わない)。
 *
 * - 未確定表現/曖昧レンジを含む decision → open question へ降格(accepted な決定にしない)。
 * - 安全語彙を含む learning → procedure を learning に降格・confidence low 強制・「要確認」タグ・
 *   一次資料確認の open question を併発。会議の発言だけを根拠に安全基準を確定させない
 *   (candidate の出典は常に会議発言であり、一次資料の裏付けは PR レビューで人間が与える)。
 * 語彙はプロンプト隣接の設定ではなくコード定数 + テストで管理する(ADR-0027 D2)。
 */
import type {
  DecisionCandidate,
  ExtractionResult,
  LearningCandidate,
  OpenQuestionCandidate,
} from "./candidate.js";

/** 未確定表現(ADR-0027 D2)。decision の title/decision/rationale への部分一致で降格する。 */
export const UNCERTAINTY_PATTERNS: readonly RegExp[] = [
  /可能性が(?:高い|ある)/,
  /かもしれ(?:ない|ません)/,
  /想定/,
  /でも(?:よい|いい)/,
  /の方向で/,
  /見込み/,
  /温度感/,
  /未確認/,
  /検討(?:する|中|したい)/,
  /持ち帰(?:り|る)/,
  /(?:たぶん|おそらく)/,
];

/** 安全関連語彙(ADR-0027 D2)。電気・圧力など、誤った確定が事故につながる領域。 */
export const SAFETY_PATTERNS: readonly RegExp[] = [
  /電圧|電源|配線|感電|漏電|絶縁|圧力|耐圧/,
  /AC\s*\d+\s*V/i,
  /\d+(?:\.\d+)?\s*MPa/i,
];

/**
 * 桁が飛ぶ数値レンジ(「5〜60万円」等)。比が 10 倍以上なら確定値として採らない(ADR-0027 D2)。
 * 「40〜60%」のような通常の幅は対象外。
 */
const RANGE_RE = /(\d+(?:\.\d+)?)\s*[〜~～]\s*(\d+(?:\.\d+)?)/g;
const AMBIGUOUS_RANGE_RATIO = 10;

/** 桁が飛ぶレンジを含むか。 */
export function hasAmbiguousRange(text: string): boolean {
  for (const m of text.matchAll(RANGE_RE)) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo > 0 && hi / lo >= AMBIGUOUS_RANGE_RATIO) return true;
  }
  return false;
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** decision の検査対象テキスト(title + 決定内容 + 理由)。 */
function decisionText(c: DecisionCandidate): string {
  return [c.title, c.decision, c.rationale ?? ""].join("\n");
}

/** 「要確認」タグ(安全ガードが付与)。gap/freshness のレビュー導線で目印になる。 */
export const NEEDS_VERIFICATION_TAG = "要確認";

export interface GuardResult {
  extraction: ExtractionResult;
  /** 未確定表現・曖昧レンジで open question に降格した decision の件数。 */
  demotedDecisions: number;
  /** 安全語彙で low 強制 + 要確認タグを付けた learning の件数。 */
  safetyFlagged: number;
}

/** 未確定 decision → open question(情報は失わず、確定だけさせない)。 */
function demoteDecision(c: DecisionCandidate, reason: string): OpenQuestionCandidate {
  return {
    kind: "open_question",
    title: c.title,
    body: `(機械ガードで decision から降格: ${reason})\n${c.decision}`,
    ...(c.lines !== undefined ? { lines: c.lines } : {}),
  };
}

/** 安全 learning の確認用 open question(一次資料での裏付けを促す・ADR-0027 D2 (d))。 */
function safetyQuestion(c: LearningCandidate): OpenQuestionCandidate {
  return {
    kind: "open_question",
    title: `【要確認】「${c.title}」の安全情報の裏付け`,
    body: "安全関連の数値・仕様が会議の発言のみを根拠に記録されている。一次資料(仕様書・実験記録・法令)での確認が必要。",
    ...(c.lines !== undefined ? { lines: c.lines } : {}),
  };
}

/**
 * 抽出結果に機械ガードを適用する(純関数。入力は変更しない)。
 * decision: 未確定表現 / 曖昧レンジ → openQuestions へ降格。
 * learning: 安全語彙 → procedure を learning に降格・confidence low・要確認タグ・確認質問を併発。
 */
export function applyCandidateGuards(extraction: ExtractionResult): GuardResult {
  const decisions: DecisionCandidate[] = [];
  const learnings: LearningCandidate[] = [];
  const openQuestions: OpenQuestionCandidate[] = [...extraction.openQuestions];
  let demotedDecisions = 0;
  let safetyFlagged = 0;

  for (const c of extraction.decisions) {
    const text = decisionText(c);
    if (matchesAny(text, UNCERTAINTY_PATTERNS)) {
      openQuestions.push(demoteDecision(c, "未確定表現を含み決定として確定できない"));
      demotedDecisions += 1;
      continue;
    }
    if (hasAmbiguousRange(text)) {
      openQuestions.push(demoteDecision(c, "桁の飛ぶ数値レンジを含み確定値にできない"));
      demotedDecisions += 1;
      continue;
    }
    decisions.push(c);
  }

  for (const c of extraction.learnings) {
    if (!matchesAny(`${c.title}\n${c.body}`, SAFETY_PATTERNS)) {
      learnings.push(c);
      continue;
    }
    const tags = c.tags.includes(NEEDS_VERIFICATION_TAG)
      ? [...c.tags]
      : [...c.tags, NEEDS_VERIFICATION_TAG];
    learnings.push({
      ...c,
      entryType: c.entryType === "procedure" ? "learning" : c.entryType,
      confidence: "low",
      tags,
    });
    openQuestions.push(safetyQuestion(c));
    safetyFlagged += 1;
  }

  return {
    extraction: { decisions, learnings, openQuestions },
    demotedDecisions,
    safetyFlagged,
  };
}
