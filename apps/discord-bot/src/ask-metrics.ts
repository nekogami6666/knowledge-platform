/**
 * /ask の工程別計測(段階 1-1・ADR-0035 追記)。完了時に 1 行の構造化ログを出すための型と整形。
 * 値は DB に保存せずログだけに出す(bot.db のスキーマ上げはホストのバッチと共有のため見送り)。
 *
 * 完了ログ(msg は {@link ASK_COMPLETION_LOG_MSG} で固定・/ask 1 件につき 1 行・correlationId 付き)の項目:
 * - outcome: answered | unanswered | timeout | error(AskResult.status。onAsk 自体の失敗は error)
 * - queryId: queries の id(onAsk が失敗した場合は null)
 * - 工程別の時間(ms・到達しなかった工程は null):
 *   - queueWaitMs: 受付(deferReply 後)→ 直列キューのタスク開始
 *   - syncMs: リポの同期(TTL 再利用の確認を含む)
 *   - promptMs: プロンプト読み込み + manifest 組み立て
 *   - searchMs: agentic search(再試行を含む)
 *   - validateMs: 引用の検証・回答の整形・queries 記録
 *   - deliveryMs: 進捗表示の停止 → 回答の配送完了
 *   - elapsedMs: handleAskRequest の所要時間(queries.elapsed_ms と同じ値)
 *   - totalMs: 受付 → 配送完了
 * - リポ同期(段階 1-2。リポ単位の同期でなければ null): reposInScope / reposAvailable /
 *   reposFetched(今回 fetch)/ reposReused(TTL 内で再利用)/ reposSkippedReset(fetch したが変化が無く reset/clean を
 *   省いた・reposFetched の内数)/ reposStale(同期失敗 → 前回データ)/
 *   reposExcluded(列挙由来のリポで同期失敗 → 今回の対象外)/ staleAgeMs(前回データのうち最も古いものの経過)
 * - 検索の観測値(最終結果から・検索が成功しなかった場合は null): numTurns / durationApiMs /
 *   deniedToolCalls / notFound / citations(モデルが返した数)/ validCitations(検証を通った数)/
 *   requestedModel / actualModel
 * - 検索の内訳(/ask 高速化の計測。最終結果から・無ければ null):
 *   - startupMs: query() の開始 → 最初の SDK メッセージ(Claude Code subprocess の起動コスト)。
 *     事前起動した subprocess を使ったときは claim → 最初の SDK メッセージ
 *   - prewarmed: 事前起動した subprocess を使ったか(ADR-0042。true / false。検索が成功しなければ null)
 *   - nonApiMs: searchMs − durationApiMs(起動・ツール実行・SDK 内部の時間。再試行があると前の試行分も含む)
 *   - toolCalls: ツール名ごとの呼び出し回数({ Read, Grep, Glob, discord_search, StructuredOutput, … }。
 *     引数・パスは載せない)/ parallelTurns: 2 つ以上のツールを同時に呼んだ API 応答の数
 *   - firstTurnCacheRead / firstTurnCacheCreation: 最初の API 応答のキャッシュ読み取り / 作成トークン
 *     (system prompt・ツール定義がキャッシュに当たったかの参考値)
 * - Discord 本文検索(ADR-0038): discordSearch({ calls, hits, ms, overLimit }。機能 OFF なら null。本文は出さない)
 * - 使用量(**全試行の合計**。形式エラーで再試行した回・最終的に失敗した回も含む。試行が無ければ null):
 *   searchAttempts(検索の試行回数)/ inputTokens / outputTokens / cacheCreationInputTokens /
 *   cacheReadInputTokens / totalCostUsd / modelUsage(モデル別の合計)。inputTokens はキャッシュ分を
 *   含まない(agent.ts 参照)。queries.input_tokens / output_tokens は従来どおり最終結果の値。
 * - 配送: expired(キュー待ちで interaction 失効 → DM 配送)/ fallbackChunks(DM で届けたチャンク数)
 * - 失敗時のみ: failedStage(queue | sync | prompt | search | validate | delivery)/ failedAtMs
 *   (受付から失敗までの ms)/ errorKind / errorCode(LlmError の code・git の分類・errno 等)
 *
 * 質問本文・回答本文・社内文書の本文・秘密値は載せない。エラーの本文(message)も載せない
 * (git の stderr は URL を含みうる。詳細は従来どおり "/ask pipeline error" の error ログに出る)。
 */
import {
  type AgentModelUsage,
  type AgentRunUsage,
  type AgentSearchResult,
  LlmError,
} from "@stratum/llm";

/** /ask の工程(失敗した工程の記録に使う)。 */
export type AskStage = "queue" | "sync" | "prompt" | "search" | "validate" | "delivery";

/** 完了ログの msg(固定。集計はこの文字列で絞る)。 */
export const ASK_COMPLETION_LOG_MSG = "/ask: 完了";

/** 検索結果から拾う観測値(ログ用)。 */
export interface AskSearchMetrics {
  numTurns: number | null;
  durationApiMs: number | null;
  deniedToolCalls: number | null;
  notFound: boolean;
  /** モデルが返した引用の数。 */
  citations: number;
  /** 検証を通った引用の数(notFound なら 0)。 */
  validCitations: number;
  requestedModel: string | null;
  actualModel: string | null;
  /** query() 開始 → 最初の SDK メッセージの ms(subprocess の起動コスト。事前起動なら claim から)。 */
  startupMs: number | null;
  /** 事前起動した subprocess を使ったか(ADR-0042)。結果に無ければ null。 */
  prewarmed: boolean | null;
  /** ツール名ごとの呼び出し回数(引数・パスは持たない)。 */
  toolCalls: Record<string, number> | null;
  /** 2 つ以上のツールを同時に呼んだ API 応答の数。 */
  parallelTurns: number | null;
  /** 最初の API 応答のキャッシュ読み取り / 作成トークン(参考値)。 */
  firstTurnCacheRead: number | null;
  firstTurnCacheCreation: number | null;
}

/** 検索の使用量(全試行の合計)。キャッシュ・費用はどの試行にも無ければ null。 */
export interface AskUsageMetrics {
  /** 検索の試行回数(再試行を含む)。試行ごとの通知が無い検索(テスト用の差し替え等)では null。 */
  searchAttempts: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  totalCostUsd: number | null;
  modelUsage: Record<string, AgentModelUsage> | null;
}

/** 試行ごとの使用量を合算する(QaSearchInput.onAttempt に add を渡す)。 */
export function createUsageAccumulator(): {
  add(u: AgentRunUsage | null): void;
  /** 合計(試行が 0 回なら null)。 */
  total(): AskUsageMetrics | null;
} {
  let attempts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation: number | null = null;
  let cacheRead: number | null = null;
  let cost: number | null = null;
  let models: Record<string, AgentModelUsage> | null = null;
  const plus = (a: number | null, b: number | undefined): number | null =>
    b === undefined ? a : (a ?? 0) + b;
  return {
    add(u) {
      attempts += 1;
      if (u === null) return;
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      cacheCreation = plus(cacheCreation, u.cacheCreationInputTokens);
      cacheRead = plus(cacheRead, u.cacheReadInputTokens);
      cost = plus(cost, u.totalCostUsd);
      for (const [model, m] of Object.entries(u.modelUsage ?? {})) {
        models ??= {};
        const prev = models[model];
        models[model] =
          prev === undefined
            ? { ...m }
            : {
                inputTokens: prev.inputTokens + m.inputTokens,
                outputTokens: prev.outputTokens + m.outputTokens,
                cacheReadInputTokens: prev.cacheReadInputTokens + m.cacheReadInputTokens,
                cacheCreationInputTokens:
                  prev.cacheCreationInputTokens + m.cacheCreationInputTokens,
                costUsd: prev.costUsd + m.costUsd,
              };
      }
    },
    total: () =>
      attempts === 0
        ? null
        : {
            searchAttempts: attempts,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheCreation,
            cacheReadInputTokens: cacheRead,
            totalCostUsd: cost,
            modelUsage: models,
          },
  };
}

/** 試行ごとの通知が無い検索(テスト用の差し替え等)の使用量を最終結果から作る。 */
export function usageOfResult(r: AgentSearchResult<unknown>): AskUsageMetrics {
  return {
    searchAttempts: null,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    cacheCreationInputTokens: r.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: r.cacheReadInputTokens ?? null,
    totalCostUsd: r.totalCostUsd ?? null,
    modelUsage: r.modelUsage ?? null,
  };
}

/** 失敗の記録(本文は持たない)。 */
export interface AskFailure {
  stage: AskStage;
  /** handleAskRequest の開始から失敗までの ms。 */
  atMs: number;
  errorKind: string;
  errorCode: string | null;
}

/** リポ同期の件数(段階 1-2。リポ単位の同期のときだけ)。 */
export interface AskSyncMetrics {
  /** 検索範囲のリポ数。 */
  reposInScope: number;
  /** 今回検索に使えたリポ数(clone のあるもの)。 */
  reposAvailable: number;
  /** 今回 fetch で同期したリポ数。 */
  reposFetched: number;
  /** TTL 内で fetch せずに再利用したリポ数。 */
  reposReused: number;
  /** reposFetched のうち、fetch の結果が HEAD と同じで作業ツリーもクリーンなため reset/clean を省いた数。 */
  reposSkippedReset: number;
  /** 同期に失敗し前回データで検索したリポ数。 */
  reposStale: number;
  /** 列挙由来(all_visible)のリポで、同期に失敗し前回データも使えず今回の対象から外した数。 */
  reposExcluded: number;
  /** 前回データのうち最も古いものの経過 ms(無ければ null)。 */
  staleAgeMs: number | null;
}

/** handleAskRequest が返す工程別の計測値(AskResult.metrics)。 */
export interface AskPipelineMetrics {
  syncMs: number | null;
  promptMs: number | null;
  searchMs: number | null;
  validateMs: number | null;
  /** handleAskRequest の所要時間(queries.elapsed_ms と同じ値)。 */
  elapsedMs: number;
  /** リポ単位の同期の件数(従来の一括同期・同期前の失敗では null)。 */
  sync: AskSyncMetrics | null;
  search: AskSearchMetrics | null;
  /** 検索の使用量(全試行の合計・検索が失敗しても試行があれば入る)。 */
  usage: AskUsageMetrics | null;
  /** Discord 本文検索(ADR-0038)の呼び出し回数と返した件数。機能 OFF・stub では null / 省略。 */
  discordSearch?: { calls: number; hits: number; ms?: number; overLimit?: number } | null;
  failure: AskFailure | null;
}

/** 検索結果 → ログ用の観測値。欠けた値は null(0 と区別する)。 */
export function searchMetricsOf(
  r: AgentSearchResult<{ notFound: boolean; citations: readonly unknown[] }>,
  validCitations: number,
): AskSearchMetrics {
  return {
    numTurns: r.numTurns ?? null,
    durationApiMs: r.durationApiMs ?? null,
    // ADR-0037: 拒否されたツール呼び出し数(cwd 外読み取りの試行等。0 超は注入の兆候として追跡)。
    deniedToolCalls: r.deniedToolCalls ?? null,
    notFound: r.value.notFound,
    citations: r.value.citations.length,
    validCitations,
    requestedModel: r.requestedModel ?? null,
    actualModel: r.actualModel ?? null,
    startupMs: r.startupMs ?? null,
    prewarmed: r.prewarmed ?? null,
    toolCalls: r.toolCalls ?? null,
    parallelTurns: r.parallelTurns ?? null,
    firstTurnCacheRead: r.firstTurnCacheRead ?? null,
    firstTurnCacheCreation: r.firstTurnCacheCreation ?? null,
  };
}

/** git の失敗の分類(stderr の定型文で判定。本文そのものはログに出さない)。 */
function classifyGitFailure(e: { stderr?: unknown; message?: unknown; killed?: unknown }): string {
  if (e.killed === true) return "GIT_TIMEOUT"; // execFile の timeout(GIT_EXEC_TIMEOUT_MS)で kill
  const text = `${typeof e.stderr === "string" ? e.stderr : ""}\n${
    typeof e.message === "string" ? e.message : ""
  }`;
  if (
    /Could not resolve host|Temporary failure in name resolution|Name or service not known/i.test(
      text,
    )
  )
    return "GIT_DNS";
  if (/timed out|Failed to connect|Connection refused|Connection reset|early EOF/i.test(text))
    return "GIT_NETWORK";
  if (
    /Authentication failed|could not read Username|terminal prompts disabled|returned error: 403/i.test(
      text,
    )
  )
    return "GIT_AUTH";
  if (/Repository not found|returned error: 404/i.test(text)) return "GIT_NOT_FOUND";
  return "GIT_ERROR";
}

/**
 * エラーの種別とコードを返す(ログ用。message は返さない)。
 * - LlmError → { LlmError, code }
 * - errno 系(ENOENT・ENOTFOUND 等の文字列 code)→ { SystemError, code }
 * - git の実行失敗(execFile のエラーで cmd が git)→ { GitError, GIT_DNS | GIT_TIMEOUT | … }
 * - cause を持つラッパ(同期失敗の AskSyncError 等)は kind を自身の名前、code を cause の分類にする
 * - それ以外 → { エラー名, null }
 */
export function classifyAskError(err: unknown): { errorKind: string; errorCode: string | null } {
  if (err instanceof LlmError) return { errorKind: "LlmError", errorCode: err.code };
  if (typeof err !== "object" || err === null) return { errorKind: typeof err, errorCode: null };
  const e = err as {
    name?: unknown;
    code?: unknown;
    cmd?: unknown;
    cause?: unknown;
    stderr?: unknown;
    message?: unknown;
    killed?: unknown;
  };
  if (typeof e.code === "string" && /^E[A-Z0-9_]+$/.test(e.code)) {
    return { errorKind: "SystemError", errorCode: e.code };
  }
  if (typeof e.cmd === "string" && /^git(\s|$)/.test(e.cmd)) {
    return { errorKind: "GitError", errorCode: classifyGitFailure(e) };
  }
  const name = typeof e.name === "string" && e.name !== "" ? e.name : "Error";
  if (e.cause !== undefined && e.cause !== err) {
    return { errorKind: name, errorCode: classifyAskError(e.cause).errorCode };
  }
  return { errorKind: name, errorCode: null };
}

/** discord.ts が完了ログを組むための入力。 */
export interface AskCompletionInput {
  /** AskResult.status(onAsk 自体が失敗したら "error")。 */
  outcome: string;
  queryId: string | null;
  metrics: AskPipelineMetrics | undefined;
  queueWaitMs: number | null;
  deliveryMs: number | null;
  totalMs: number;
  expired: boolean;
  fallbackChunks: number;
  /**
   * handleAskRequest の外での失敗(onAsk の reject = dispatch 失敗、または配送失敗)。
   * handleAskRequest 内の失敗は metrics.failure に入っている(そちらを優先する)。
   */
  outerFailure?: { stage: AskStage; atMs: number; err: unknown };
}

/** 完了ログの項目を組む(純関数。項目名は本ファイル冒頭の一覧どおり)。 */
export function buildAskCompletionLog(input: AskCompletionInput): Record<string, unknown> {
  const m = input.metrics;
  const s = m?.search ?? null;
  const u = m?.usage ?? null;
  const searchMs = m?.searchMs ?? null;
  const durationApiMs = s?.durationApiMs ?? null;
  const fields: Record<string, unknown> = {
    outcome: input.outcome,
    queryId: input.queryId,
    totalMs: input.totalMs,
    queueWaitMs: input.queueWaitMs,
    syncMs: m?.syncMs ?? null,
    promptMs: m?.promptMs ?? null,
    searchMs,
    validateMs: m?.validateMs ?? null,
    deliveryMs: input.deliveryMs,
    elapsedMs: m?.elapsedMs ?? null,
    reposInScope: m?.sync?.reposInScope ?? null,
    reposAvailable: m?.sync?.reposAvailable ?? null,
    reposFetched: m?.sync?.reposFetched ?? null,
    reposReused: m?.sync?.reposReused ?? null,
    reposSkippedReset: m?.sync?.reposSkippedReset ?? null,
    reposStale: m?.sync?.reposStale ?? null,
    reposExcluded: m?.sync?.reposExcluded ?? null,
    staleAgeMs: m?.sync?.staleAgeMs ?? null,
    numTurns: s?.numTurns ?? null,
    durationApiMs,
    startupMs: s?.startupMs ?? null,
    prewarmed: s?.prewarmed ?? null,
    nonApiMs: searchMs !== null && durationApiMs !== null ? searchMs - durationApiMs : null,
    toolCalls: s?.toolCalls ?? null,
    parallelTurns: s?.parallelTurns ?? null,
    firstTurnCacheRead: s?.firstTurnCacheRead ?? null,
    firstTurnCacheCreation: s?.firstTurnCacheCreation ?? null,
    deniedToolCalls: s?.deniedToolCalls ?? null,
    notFound: s?.notFound ?? null,
    citations: s?.citations ?? null,
    validCitations: s?.validCitations ?? null,
    searchAttempts: u?.searchAttempts ?? null,
    inputTokens: u?.inputTokens ?? null,
    outputTokens: u?.outputTokens ?? null,
    cacheCreationInputTokens: u?.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: u?.cacheReadInputTokens ?? null,
    totalCostUsd: u?.totalCostUsd ?? null,
    modelUsage: u?.modelUsage ?? null,
    requestedModel: s?.requestedModel ?? null,
    actualModel: s?.actualModel ?? null,
    discordSearch: m?.discordSearch ?? null,
    expired: input.expired,
    fallbackChunks: input.fallbackChunks,
  };
  const inner = m?.failure ?? null;
  if (inner !== null) {
    // 受付からの経過に直す(キュー待ち + パイプライン内の経過)。
    fields.failedStage = inner.stage;
    fields.failedAtMs = (input.queueWaitMs ?? 0) + inner.atMs;
    fields.errorKind = inner.errorKind;
    fields.errorCode = inner.errorCode;
  } else if (input.outerFailure !== undefined) {
    const c = classifyAskError(input.outerFailure.err);
    fields.failedStage = input.outerFailure.stage;
    fields.failedAtMs = input.outerFailure.atMs;
    fields.errorKind = c.errorKind;
    fields.errorCode = c.errorCode;
  }
  return fields;
}
