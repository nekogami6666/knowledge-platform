/**
 * @stratum/kb-core — knowledge-base の型の唯一の正(design.md §6.1)。
 * すべてのアプリは knowledge-base の読み書きをこのパッケージ経由で行う。
 */

// --- frontmatter I/O ---
export {
  type DocKind,
  type ParsedEntry,
  parseEntry,
  safeParseEntry,
  serializeEntry,
} from "./entry-io.js";
// --- エラー ---
export {
  KbIdError,
  type KbIssue,
  KbParseError,
  type KbParseErrorCode,
  KbProvenanceError,
} from "./errors.js";
// --- expertise マップ I/O(expertise/expertise.yaml・§4.5 / ADR-0017 D5)---
export {
  parseExpertiseMap,
  sameExpertiseContent,
  serializeExpertiseMap,
} from "./expertise-io.js";
// --- ID 採番 ---
export {
  type AllocateIdOptions,
  allocateId,
  createLocalIdCounterStore,
  type IdCounterFile,
  type IdCounterStore,
  type IdKind,
} from "./id-allocator.js";
// --- members 対応表(_meta/members.yaml・ADR-0017 D3)---
export {
  discordForGithub,
  githubForDiscord,
  nameForDiscord,
  nameForGithub,
  parseMembers,
} from "./members-io.js";
// --- provenance ---
export {
  parseLineRange,
  type SourceUrlOptions,
  sourceToUrl,
  urlToSource,
} from "./provenance.js";
// --- スキーマと推論型(利用側での型再定義禁止。CLAUDE.md §12.2) ---
export {
  type BotAnswerQuality,
  botAnswerQualitySchema,
  type Confidence,
  confidenceSchema,
  DEFAULT_REVIEW_INTERVAL_DAYS,
  type DrId,
  type DrStatus,
  drIdSchema,
  drStatusSchema,
  type EntryStatus,
  type EntryType,
  entryStatusSchema,
  entryTypeSchema,
  type KbId,
  kbIdSchema,
  type QId,
  type QuestionStatus,
  qIdSchema,
  questionStatusSchema,
  type Risk,
  riskSchema,
  type SourceKind,
  sourceKindSchema,
} from "./schemas/common.js";
export {
  type DecisionRecord,
  decisionRecordSchema,
} from "./schemas/decision-record.js";
export {
  type ExpertiseMap,
  type ExpertisePerson,
  type ExpertiseTopic,
  expertiseMapSchema,
} from "./schemas/expertise-map.js";
export {
  type KnowledgeEntry,
  knowledgeEntrySchema,
} from "./schemas/knowledge-entry.js";
export {
  type Member,
  type Members,
  memberSchema,
  membersSchema,
} from "./schemas/members.js";
export {
  type QuestionLog,
  questionLogSchema,
} from "./schemas/question-log.js";
export {
  type Source,
  sourceSchema,
  sourcesSchema,
} from "./schemas/source.js";
// --- リポジトリ検証 ---
export {
  type RepoProblem,
  type RepoValidationReport,
  validateRepo,
} from "./validate-repo.js";
// --- voice-memo 原本(§6.4 ③-b / ADR-0015)---
export {
  buildVoiceMemoDoc,
  VOICE_MEMOS_DIR,
  type VoiceMemoDocInput,
  voiceMemoPath,
} from "./voice-memo.js";
