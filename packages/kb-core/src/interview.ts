/**
 * interviews のパス規約とセッション原本の生成(ADR-0028 D4 / design.md §6.6 ⑤-b)。
 * kits(質問リスト)・sessions(面談の文字起こし原本)はナレッジエントリではない
 * (DocKind 対象外・validate-repo 非走査)が、置き場所と体裁の規約は kb-core に一元化する
 * (interview-kit / discord-bot / extractor が同じ規約を読むため。VOICE_MEMOS_DIR の前例)。
 *
 * sessions/ は extractor の interviews ソースの抽出対象(除外は kits / voice-memos のみ)。
 * よって原本の冒頭には extractor の parseParticipants 契約(「参加者: A, B」1 行・カンマ区切り)と
 * 源泉日規約(パスの YYYY-MM-DD)に適合するメタを置く。
 */

/** 質問キットの置き場所プレフィックス(§4.1)。extractor からは除外(PR-I1)。 */
export const INTERVIEW_KITS_DIR = "interviews/kits";

/** セッション原本の置き場所プレフィックス(ADR-0028 D4)。extractor の抽出対象。 */
export const INTERVIEW_SESSIONS_DIR = "interviews/sessions";

/**
 * ファイル名/ブランチ名用スラグ(extractor/src/slug.ts と同じ規則)。
 * 日本語は ASCII 化で空になりうるため "x" にフォールバック(パスの一意性は
 * 呼び出し側が sessionId 等のサフィックスで担保する)。
 */
export function interviewSlug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s.length > 0 ? s : "x";
}

/** 質問キットのリポジトリ相対パス(interview-kit と同一規約。旧 questions.ts kitPath)。 */
export function interviewKitPath(person: string, topic: string): string {
  return `${INTERVIEW_KITS_DIR}/${interviewSlug(person)}-${interviewSlug(topic)}.md`;
}

/**
 * セッション原本のリポジトリ相対パス。
 * `interviews/sessions/<YYYY>/<YYYY-MM-DD>-<slug(person)>-<slug(topic)>-<sessionId 先頭6字>.md`。
 * dateJst は JST の YYYY-MM-DD(§7.5)— extractor の源泉日パース(source-date.ts)がこの部分を
 * 拾い、抽出エントリの日付・ID 年に伝わる(ADR-0026 D3)。sessionId サフィックスは
 * slug の "x" フォールバック同士の衝突を防ぐ(ADR-0028 D4)。
 */
export function interviewSessionPath(
  dateJst: string,
  person: string,
  topic: string,
  sessionId: string,
): string {
  const year = dateJst.slice(0, 4);
  const sid = sessionId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 6)
    .toLowerCase();
  return `${INTERVIEW_SESSIONS_DIR}/${year}/${dateJst}-${interviewSlug(person)}-${interviewSlug(
    topic,
  )}-${sid}.md`;
}

export interface InterviewSessionDocInput {
  /** 対象者(表示名 or GitHub 名)。 */
  person: string;
  /** 面談テーマ。 */
  topic: string;
  /** 使った質問キットのリポジトリ相対パス(無しは null)。 */
  kitPath: string | null;
  /** 参加者の表示名(person・聞き手を含む。extractor の people/owner 解決に使われる)。 */
  participants: string[];
  /** JST の YYYY-MM-DD(録音日 = 源泉日)。 */
  dateJst: string;
  /** 使用した STT モデル(来歴)。 */
  sttModel: string;
  /** 録音元 VC の URL(P2 provenance)。 */
  channelUrl: string;
  /** 結合したチャンク本数(自動分割の来歴)。 */
  chunkCount: number;
  /** チャンクを seq 順に結合した文字起こし全文(無加工・P1)。 */
  transcript: string;
}

/**
 * セッション原本 Markdown を生成する。冒頭の「参加者:」行は extractor の parseParticipants
 * (区切り `,`・`、`・`/`)が拾う契約。文字起こしは無加工で「## 文字起こし」以下に置く。
 */
export function buildInterviewSessionDoc(input: InterviewSessionDocInput): string {
  return [
    `# インタビュー: ${input.person} × ${input.topic}(${input.dateJst})`,
    "",
    `参加者: ${input.participants.join(", ")}`,
    "",
    `- 対象者: ${input.person}`,
    `- テーマ: ${input.topic}`,
    ...(input.kitPath !== null ? [`- 質問キット: \`${input.kitPath}\``] : []),
    `- 録音元 VC: ${input.channelUrl}`,
    `- 文字起こし: ${input.sttModel}(チャンク ${input.chunkCount} 本・自動分割)`,
    "",
    "## 文字起こし",
    "",
    input.transcript.trim(),
    "",
  ].join("\n");
}
