import { LlmError } from "@stratum/llm";
import { describe, expect, it } from "vitest";
import {
  type AskPipelineMetrics,
  buildAskCompletionLog,
  classifyAskError,
  createUsageAccumulator,
} from "./ask-metrics.js";

/** execFile(git)の失敗と同じ形のエラー。 */
function gitError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed: git fetch\n${stderr}`), {
    cmd: "git -C /clones/kb fetch --depth=1 https://github.com/org/kb.git",
    stderr,
    code: 128,
    ...extra,
  });
}

describe("classifyAskError(段階 1-1: 失敗の種別。本文は返さない)", () => {
  it("LlmError は code をそのまま返す", () => {
    expect(classifyAskError(new LlmError("TIMEOUT", "x"))).toEqual({
      errorKind: "LlmError",
      errorCode: "TIMEOUT",
    });
  });

  it("git の失敗は stderr の定型文で分類する(DNS・タイムアウト・通信・認証・不在・その他)", () => {
    const code = (e: unknown) => classifyAskError(e).errorCode;
    expect(code(gitError("fatal: unable to access '…': Could not resolve host: github.com"))).toBe(
      "GIT_DNS",
    );
    expect(code(gitError("", { killed: true, signal: "SIGTERM" }))).toBe("GIT_TIMEOUT");
    expect(code(gitError("fatal: unable to access '…': Failed to connect to github.com"))).toBe(
      "GIT_NETWORK",
    );
    expect(code(gitError("fatal: Authentication failed for '…'"))).toBe("GIT_AUTH");
    expect(code(gitError("remote: Repository not found."))).toBe("GIT_NOT_FOUND");
    expect(code(gitError("fatal: something else"))).toBe("GIT_ERROR");
    expect(classifyAskError(gitError("x")).errorKind).toBe("GitError");
  });

  it("errno 系は SystemError + code、cause を持つラッパは cause を分類、その他は名前だけ", () => {
    expect(classifyAskError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toEqual({
      errorKind: "SystemError",
      errorCode: "ENOTFOUND",
    });
    class Wrapped extends Error {
      override readonly name = "AskSyncError";
    }
    expect(
      classifyAskError(new Wrapped("x", { cause: gitError("Could not resolve host: github.com") })),
    ).toEqual({ errorKind: "AskSyncError", errorCode: "GIT_DNS" });
    expect(classifyAskError(new TypeError("boom"))).toEqual({
      errorKind: "TypeError",
      errorCode: null,
    });
    expect(classifyAskError("str")).toEqual({ errorKind: "string", errorCode: null });
  });
});

describe("buildAskCompletionLog(1 行の完了ログ)", () => {
  const metrics: AskPipelineMetrics = {
    syncMs: 1200,
    promptMs: 3,
    searchMs: 30_000,
    validateMs: 5,
    elapsedMs: 31_208,
    sync: null,
    search: {
      numTurns: 9,
      durationApiMs: 28_000,
      deniedToolCalls: 0,
      notFound: false,
      citations: 2,
      validCitations: 1,
      requestedModel: "m",
      actualModel: "m",
    },
    usage: {
      searchAttempts: 2,
      inputTokens: 10,
      outputTokens: 500,
      cacheCreationInputTokens: 3000,
      cacheReadInputTokens: 40_000,
      totalCostUsd: 0.07,
      modelUsage: null,
    },
    failure: null,
  };

  it("成功: 全工程の時間と検索の観測値を平らに並べる(失敗項目は持たない)", () => {
    const f = buildAskCompletionLog({
      outcome: "answered",
      queryId: "q1",
      metrics,
      queueWaitMs: 4000,
      deliveryMs: 300,
      totalMs: 35_600,
      expired: false,
      fallbackChunks: 0,
    });
    expect(f).toMatchObject({
      outcome: "answered",
      queryId: "q1",
      totalMs: 35_600,
      queueWaitMs: 4000,
      syncMs: 1200,
      promptMs: 3,
      searchMs: 30_000,
      validateMs: 5,
      deliveryMs: 300,
      elapsedMs: 31_208,
      numTurns: 9,
      citations: 2,
      validCitations: 1,
      searchAttempts: 2,
      cacheReadInputTokens: 40_000,
      totalCostUsd: 0.07,
      requestedModel: "m",
      actualModel: "m",
    });
    expect("failedStage" in f).toBe(false);
  });

  it("パイプライン内の失敗は受付からの経過(キュー待ち + 失敗時点)に直して載せる", () => {
    const f = buildAskCompletionLog({
      outcome: "error",
      queryId: "q1",
      metrics: {
        ...metrics,
        searchMs: null,
        validateMs: null,
        search: null,
        failure: { stage: "search", atMs: 900, errorKind: "LlmError", errorCode: "API_ERROR" },
      },
      queueWaitMs: 100,
      deliveryMs: 20,
      totalMs: 1020,
      expired: false,
      fallbackChunks: 0,
      // 配送も失敗していてもパイプラインの失敗を優先する。
      outerFailure: { stage: "delivery", atMs: 1020, err: new Error("x") },
    });
    expect(f).toMatchObject({
      failedStage: "search",
      failedAtMs: 1000,
      errorKind: "LlmError",
      errorCode: "API_ERROR",
      searchMs: null,
      numTurns: null,
    });
  });

  it("onAsk の失敗・配送の失敗は outerFailure から分類する", () => {
    const f = buildAskCompletionLog({
      outcome: "error",
      queryId: null,
      metrics: undefined,
      queueWaitMs: null,
      deliveryMs: null,
      totalMs: 50,
      expired: false,
      fallbackChunks: 0,
      outerFailure: { stage: "queue", atMs: 50, err: new TypeError("x") },
    });
    expect(f).toMatchObject({
      outcome: "error",
      queryId: null,
      syncMs: null,
      failedStage: "queue",
      failedAtMs: 50,
      errorKind: "TypeError",
      errorCode: null,
    });
  });
});

describe("createUsageAccumulator(全試行の合計)", () => {
  it("試行 0 回は null。キャッシュ・費用はどの試行にも無ければ null、あれば報告分だけ足す", () => {
    const acc = createUsageAccumulator();
    expect(acc.total()).toBeNull();
    acc.add({ inputTokens: 1, outputTokens: 2 });
    expect(acc.total()).toMatchObject({ searchAttempts: 1, totalCostUsd: null, modelUsage: null });
    acc.add(null);
    acc.add({ inputTokens: 3, outputTokens: 4, totalCostUsd: 0.5 });
    expect(acc.total()).toMatchObject({
      searchAttempts: 3,
      inputTokens: 4,
      outputTokens: 6,
      totalCostUsd: 0.5,
      cacheReadInputTokens: null,
    });
  });
});
