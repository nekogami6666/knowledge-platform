/**
 * voice-memo 原本(文字起こし全文)のパス規約とドキュメント生成(design.md §6.4 ③-b / ADR-0015 D4)。
 * 原本はナレッジエントリではない(DocKind 対象外・validate-repo の走査対象外)ため frontmatter
 * スキーマを持たないが、置き場所と体裁の規約は kb-core に一元化する(extractor / interview-kit が
 * 将来同じ規約を読むため)。本文の文字起こしは無加工で保持する(P1)。
 */

/** 原本の置き場所プレフィックス(§4.1 リポジトリ構成)。 */
export const VOICE_MEMOS_DIR = "interviews/voice-memos";

/**
 * 原本のリポジトリ相対パス。`interviews/voice-memos/<YYYY>/<date>-<messageId>.md`。
 * date は JST の YYYY-MM-DD(§7.5)。messageId(Discord snowflake)で決定的 = 冪等。
 */
export function voiceMemoPath(dateJst: string, messageId: string): string {
  const year = dateJst.slice(0, 4);
  return `${VOICE_MEMOS_DIR}/${year}/${dateJst}-${messageId}.md`;
}

export interface VoiceMemoDocInput {
  /** 文字起こし全文(無加工で本文に置く・P1)。 */
  transcript: string;
  /** 投稿メッセージの Discord permalink(P2 provenance)。 */
  messageUrl: string;
  /** 投稿者(GitHub 名。未マップは "unassigned")。 */
  author: string;
  /** JST の YYYY-MM-DD。 */
  dateJst: string;
  /** 使用した STT モデル(来歴)。 */
  sttModel: string;
}

/**
 * 原本 Markdown を生成する。冒頭に最小限の来歴(投稿者・日付・permalink・STT モデル)を置き、
 * 「## 文字起こし」以下に全文を無加工で置く。訂正フライホイール(PR-V4)はこの節を書き換える。
 */
export function buildVoiceMemoDoc(input: VoiceMemoDocInput): string {
  return [
    `# Voice memo ${input.dateJst}(${input.author})`,
    "",
    `- 出典: ${input.messageUrl}`,
    `- 文字起こし: ${input.sttModel}`,
    "",
    "## 文字起こし",
    "",
    input.transcript.trim(),
    "",
  ].join("\n");
}
