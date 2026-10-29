/**
 * discord-bot エントリポイント(design.md §6.2 C1)。
 * env / config をロードし、SQLite ストア・RepoSyncer・プロンプトローダ・検索パイプラインを
 * 組み立てて /ask を配線し、Discord にログインする。
 */
import { randomUUID } from "node:crypto";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { createGhClientFromAuth, createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { validateRepo } from "@stratum/kb-core";
import {
  type AgentPrewarmPool,
  createAgentPrewarmPool,
  createFsPromptStore,
  createOpenAiTranscriber,
  DEFAULT_PREWARM_IDLE_MS,
  nullUsageRecorder,
  type Transcriber,
} from "@stratum/llm";
import { describeError } from "@stratum/shared";
import { type Client, Events, Routes } from "discord.js";
import { setNotifySecrets } from "./ack.js";
import {
  type AskDeps,
  DEFAULT_ASK_SYNC_MAX_STALENESS_MS,
  DEFAULT_ASK_SYNC_TTL_MS,
  DEFAULT_ASK_TIMEOUT_MS,
  handleAskRequest,
  INTERRUPTED_MESSAGE,
} from "./ask.js";
import {
  createAskLifecycle,
  createShutdownHandler,
  DEFAULT_SHUTDOWN_GRACE_MS,
  recoverInterruptedAsks,
  safeErrorInfo,
} from "./ask-lifecycle.js";
import { SerialQueue } from "./concurrency.js";
import {
  createFsConfigReader,
  loadChannels,
  loadDiscordIndex,
  loadOps,
  loadRepos,
  loadVoice,
} from "./config.js";
import {
  type AskHandler,
  buildVcSnapshot,
  createBot,
  createClientMessenger,
  warmDmChannels,
} from "./discord.js";
import { attachDiscordIndexListeners, createDiscordIndexSource } from "./discord-index-discord.js";
import { createDiscordIndexStore, type DiscordIndexStore } from "./discord-index-store.js";
import { createDiscordIndexSync } from "./discord-index-sync.js";
import { searchScopeFromInteraction } from "./discord-search-scope.js";
import { createDiscordSearchSession } from "./discord-search-tool.js";
import { parseEnv, parsePositiveIntEnv } from "./env.js";
import { createFreshnessDmWorker, type FreshnessApplyDeps } from "./freshness-flow.js";
import type { InterviewCommandDeps } from "./interview-commands.js";
import {
  bindingWithPanelRefresh,
  ensurePanel,
  type InterviewPanelDeps,
  type PanelChannel,
  refreshPanel,
} from "./interview-panel.js";
import { createInterviewSessionWorker } from "./interview-pipeline.js";
import { createInterviewChunkBinding } from "./interview-session.js";
import { loadInterviewTopics } from "./interview-topics.js";
import { createLogger, withCorrelation } from "./logger.js";
import { createCloneMembersLoader, DEFAULT_KB_DIR } from "./members.js";
import { createQaSearch } from "./qa-search.js";
import { createRepoRegistry } from "./repo-registry.js";
import {
  type CloneCleanupDeps,
  createPeriodicRepoSync,
  DEFAULT_REPO_SYNC_INTERVAL_MS,
  manualScope,
  nodeCloneFs,
  type PeriodicRepoSync,
  removeOutOfScopeClones,
  resolveScopeOnce,
  type ScopeResolveDeps,
  withManagedCloneRecording,
} from "./repo-sync.js";
import { createGitRepoSyncer } from "./repos.js";
import { createSqliteStore } from "./sqlite-store.js";
import { isoJst } from "./time.js";
import {
  createRecorderClient,
  createVcRecorderWatcher,
  type VcRecorderWatcher,
  type VcSnapshot,
} from "./vc-recorder.js";
import { createVoiceMemoWorker } from "./voice-pipeline.js";

async function main(): Promise<void> {
  const env = parseEnv();
  // §9.1: env の秘密「値」をログ最終行から伏字化(err.message 混入も捕捉。logger.ts (A))。
  // 全 AI 操作は Claude on AWS 経由(ADR-0009)。GitHub 認証(任意)も対象に含める。
  const secrets = [
    env.DISCORD_TOKEN,
    env.ANTHROPIC_AWS_API_KEY,
    env.GITHUB_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.OPENAI_API_KEY,
    env.GIT_CLONE_TOKEN,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const logger = createLogger("info", undefined, secrets);
  // Discord 送信もログと同じ秘密値で伏字化する(ADR-0030。例外文言の混入対策・§9.1)。
  setNotifySecrets(secrets);

  const reader = createFsConfigReader(env.CONFIG_DIR);
  const channels = await loadChannels(reader);
  const reposConfig = await loadRepos(reader);
  // clone 認証は env から実行時注入(㉞: /config はエージェント可視 — 平文トークンを置かない)。
  if (reposConfig.repos.some((r) => r.url !== undefined && /^https:\/\/[^@/]+@/.test(r.url))) {
    logger.warn(
      "repos.yaml の url に認証情報が埋め込まれています。トークンを GIT_CLONE_TOKEN(env)へ移し、URL から外してください(§9.1)。",
    );
  }
  // repos: の手動指定(url にトークン注入済み)。KB の dir・鮮度確認の KB 同期はここから引く。
  const repos = manualScope(reposConfig.repos, env.GIT_CLONE_TOKEN);
  const ops = await loadOps(reader);
  const voice = await loadVoice(reader);
  // ADR-0038: Discord 本文インデックス(既定 OFF。OFF なら DB を作らずイベントも購読しない)。
  const discordIndexConfig = await loadDiscordIndex(reader);

  // members 対応表は KB clone の _meta/members.yaml が唯一の正(ADR-0017 D3)。
  // clone 先 dir は repos.yaml の ops.kb_repo 該当エントリから引く(無ければ既定名)。
  const kbDir = repos.find((r) => r.repo === ops.kb_repo)?.dir ?? DEFAULT_KB_DIR;
  // ADR-0036 D1: all_visible があれば GIT_CLONE_TOKEN で見える org のリポを列挙して検索範囲を決める
  // (トークンの可視範囲 = 検索範囲)。null なら手動指定のみ(従来挙動・列挙も定期同期もしない)。
  // 列挙に失敗した起動は手動指定のみで始め、定期同期で再試行する。
  const allVisible = reposConfig.all_visible;
  const cloneToken = env.GIT_CLONE_TOKEN;
  const cloneGh =
    allVisible !== null && cloneToken !== undefined && cloneToken.length > 0
      ? createGhClientFromAuth({ kind: "token", token: cloneToken })
      : undefined;
  const scopeDeps: ScopeResolveDeps = {
    manual: reposConfig.repos,
    allVisible,
    ...(cloneGh !== undefined ? { listOrgRepos: (org: string) => cloneGh.listOrgRepos(org) } : {}),
    cloneToken,
    logger,
  };
  const startupScope = allVisible !== null ? await resolveScopeOnce(scopeDeps) : null;
  const registry = createRepoRegistry(startupScope ?? repos);
  const getMembers = createCloneMembersLoader({ clonesDir: env.CLONES_DIR, kbDir, logger });

  // 👍 代理マージ(§6.3): ops.yaml と GitHub 認証が両方揃ったときだけ有効(既定 OFF)。
  // 認証未整備(AUTH エラー)は機能 OFF として起動を続ける(bot の主務は /ask)。
  let gh: GhClient | undefined;
  if (ops.channel_id !== null && ops.kb_repo !== null) {
    try {
      gh = createGhClientFromEnv();
    } catch {
      logger.warn(
        "ops.yaml はあるが GitHub 認証(GITHUB_TOKEN か App trio)が無いため 👍 代理マージは無効です(ADR-0011)。",
      );
    }
  }
  logger.info(
    {
      permanentExclude: channels.permanent_exclude.length,
      membersSource: `${kbDir}/_meta/members.yaml`,
      repos: repos.length,
      allVisible: allVisible !== null,
      scope: registry.scope().length,
      proxyMerge: gh !== undefined,
      voiceMemo: voice.channel_id !== null,
      discordIndex: discordIndexConfig.enabled,
    },
    "config loaded",
  );
  if (channels.allow !== undefined && channels.allow.length > 0) {
    logger.warn(
      "channels.allow は廃止されました(ADR-0018: bot が見えるチャンネルを読みます)。行を削除してください(無視されます)。",
    );
  }
  if (registry.scope().length === 0) {
    logger.warn("repos.yaml が空です。検索対象リポがありません(§14 #5)。");
  }
  if (voice.max_recording_minutes > 22) {
    logger.warn(
      { maxRecordingMinutes: voice.max_recording_minutes },
      "max_recording_minutes > 22 は 128kbps AAC のチャンクが STT の 25MB 上限に接近します(ADR-0028 D2)。",
    );
  }

  const store = createSqliteStore(env.DB_PATH);
  // ADR-0035 追記: 前回プロセスが強制終了で残した処理中 /ask。新規受付より前に読んでおき、
  // ClientReady で書き換えてから id 単位で消す(起動後に受け付けた行は対象にしない)。
  const strandedAsks = store.listInflightAsks();
  // ADR-0035 追記: /ask の受付・追跡・正常終了。SIGTERM のハンドラと createBot が共有する。
  const lifecycleLog = {
    info: (data: Record<string, unknown>, msg: string) => logger.info(data, msg),
    warn: (data: Record<string, unknown>, msg: string) => logger.warn(data, msg),
  };
  const askLifecycle = createAskLifecycle({
    store,
    newId: () => randomUUID(),
    graceMs: parsePositiveIntEnv(
      "SHUTDOWN_GRACE_MS",
      env.SHUTDOWN_GRACE_MS,
      DEFAULT_SHUTDOWN_GRACE_MS,
      (data, msg) => logger.warn(data, msg),
    ),
    log: lifecycleLog,
  });
  // ADR-0038 D2: bot.db とは別ファイル。有効なときだけ開く。
  const discordIndexStore: DiscordIndexStore | undefined = discordIndexConfig.enabled
    ? createDiscordIndexStore(env.DISCORD_INDEX_DB_PATH)
    : undefined;
  const gitSyncer = createGitRepoSyncer(env.CLONES_DIR);
  // ADR-0036 D4: all_visible 有効時は、列挙由来のリポを新規に clone する前に managed_clones へ記録する
  // (定期同期と /ask の sync_on_ask 分の両方)。無効なら従来の syncer そのまま。
  const syncer =
    allVisible !== null
      ? withManagedCloneRecording(gitSyncer, {
          store,
          clonesDir: env.CLONES_DIR,
          fs: nodeCloneFs,
          nowIso: () => isoJst(),
        })
      : gitSyncer;
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);
  // §6.2 /ask の直列キュー。定期同期(ADR-0036 D5)と鮮度確認の KB 書き込みも同じキューに載せ、
  // 検索中の reset --hard・書き込み途中の同期を起こさない(ADR-0035 の既知レース)。
  const queue = new SerialQueue();

  // §6.7(ADR-0019 D2/D3): 鮮度確認 DM への 👍✏️🗑 応答。👍/🗑 は main 直 commit のため
  // gh 認証 + ops.kb_repo(§6.3 と同じ唯一の書き込み先)が前提。無ければ機能 OFF。
  let freshness: FreshnessApplyDeps | undefined;
  if (gh !== undefined && ops.kb_repo !== null) {
    const kbRepo = ops.kb_repo;
    const kbSpec = repos.find((r) => r.repo === kbRepo) ?? { repo: kbRepo, dir: kbDir };
    freshness = {
      store,
      gh,
      kbRepo,
      // gh-client の既定と同じ(KB の base ブランチを変える場合はここも設定化する)。
      baseBranch: "main",
      // KB clone を触る区間(sync → 書き込み → validate → commit)を /ask・定期同期と直列化する。
      // syncKbClone は区間の内側で呼ばれるためキューに積まない(積むとデッドロック)。
      runExclusive: (task) => queue.enqueue(task),
      // 段階 1-2: KB の作業ツリーを触ったら、次の /ask は TTL 内でも KB を同期し直す。
      onKbTreeTouched: () => registry.invalidate(kbRepo),
      syncKbClone: async () => {
        const [synced] = await syncer.sync([kbSpec]);
        if (synced === undefined) throw new Error("KB clone の同期に失敗しました");
        return synced.absDir;
      },
      readFile: (p) => fsReadFile(p, "utf8"),
      writeFile: (p, c) => fsWriteFile(p, c, "utf8"),
      validate: (root) => validateRepo(root),
      today: () => isoJst().slice(0, 10),
      makeId: () => randomUUID(),
      nowIso: () => isoJst(),
      logger,
    };
  } else {
    logger.info(
      "鮮度確認の応答 UI は無効です(GitHub 認証か ops.kb_repo が未設定・§6.7 / ADR-0019)。",
    );
  }

  // 実 agentic search(runAgentSearch + §6.2 リトライ)を共有ファクトリで構築。
  // golden eval も同じ createQaSearch を使い、同一パイプラインを評価する(PR-5)。
  // /ask の検索タイムアウト(既定 600s・ADR-0035 D1)。不正値は既定へフォールバック + warn。
  // 検索の実挙動とタイムアウト文面の秒数表示が単一値を共有する(表示だけズレる事故を防ぐ)。
  const effectiveAskTimeoutMs = parsePositiveIntEnv(
    "ASK_TIMEOUT_MS",
    env.ASK_TIMEOUT_MS,
    DEFAULT_ASK_TIMEOUT_MS,
    (data, msg) => logger.warn(data, msg),
  );
  // ADR-0035 D6: 探索量の実験ノブ。未設定なら既定(maxTurns 30・effort/thinking は SDK 任せ)。
  const askMaxTurnsRaw = env.ASK_MAX_TURNS;
  const askMaxTurns =
    askMaxTurnsRaw === undefined || askMaxTurnsRaw.trim() === ""
      ? undefined
      : parsePositiveIntEnv("ASK_MAX_TURNS", askMaxTurnsRaw, 30, (data, msg) =>
          logger.warn(data, msg),
        );
  if (askMaxTurns !== undefined || env.ASK_EFFORT !== undefined || env.ASK_THINKING !== undefined) {
    logger.info(
      {
        maxTurns: askMaxTurns ?? null,
        effort: env.ASK_EFFORT ?? null,
        thinking: env.ASK_THINKING ?? null,
      },
      "/ask の探索ノブが env で上書きされています(ADR-0035 D6)",
    );
  }
  // 段階 1-2: /ask の同期の TTL 再利用と、同期失敗時に前回データで検索してよい期間。
  const askSyncTtlMs = parsePositiveIntEnv(
    "ASK_SYNC_TTL_MS",
    env.ASK_SYNC_TTL_MS,
    DEFAULT_ASK_SYNC_TTL_MS,
    (data, msg) => logger.warn(data, msg),
  );
  const askSyncMaxStalenessMs = parsePositiveIntEnv(
    "ASK_SYNC_MAX_STALENESS_MS",
    env.ASK_SYNC_MAX_STALENESS_MS,
    DEFAULT_ASK_SYNC_MAX_STALENESS_MS,
    (data, msg) => logger.warn(data, msg),
  );
  // ADR-0042: Claude Code subprocess の事前起動(既定 off)。待機は最大 1 本・ASK_PREWARM_IDLE_MS で閉じる。
  // 失敗・不一致は警告して従来の起動に倒れる(/ask は止まらない)。正常終了の stopTimers で閉じる。
  let askPrewarm: AgentPrewarmPool | undefined;
  if (env.ASK_PREWARM === "on") {
    const idleMs = parsePositiveIntEnv(
      "ASK_PREWARM_IDLE_MS",
      env.ASK_PREWARM_IDLE_MS,
      DEFAULT_PREWARM_IDLE_MS,
      (data, msg) => logger.warn(data, msg),
    );
    askPrewarm = createAgentPrewarmPool({ idleMs, onWarn: (data, msg) => logger.warn(data, msg) });
    logger.info({ idleMs }, "/ask の subprocess 事前起動を有効化しました(ADR-0042)");
  }
  const search = createQaSearch({
    usage: nullUsageRecorder,
    timeoutMs: effectiveAskTimeoutMs,
    ...(askMaxTurns !== undefined ? { maxTurns: askMaxTurns } : {}),
    ...(env.ASK_EFFORT !== undefined ? { effort: env.ASK_EFFORT } : {}),
    ...(env.ASK_THINKING !== undefined ? { thinking: env.ASK_THINKING } : {}),
    ...(askPrewarm !== undefined ? { prewarm: askPrewarm } : {}),
  });

  const onAsk: AskHandler = (question, ctx) => {
    // ADR-0038 D5/D6: 本文インデックスが有効なら、質問者の検索範囲で discord_search を作る
    // (範囲が判定できない・空、または max_tool_calls: 0 ならツールは渡さず、discord 引用は全て破棄される)。
    const discordSearch =
      discordIndexStore !== undefined && ctx.discordScope !== undefined
        ? createDiscordSearchSession({
            store: discordIndexStore,
            scope: ctx.discordScope ?? { guildId: "", channelIds: new Set() },
            maxResults: discordIndexConfig.max_results,
            excerptChars: discordIndexConfig.excerpt_chars,
            maxToolCalls: discordIndexConfig.max_tool_calls,
          })
        : undefined;
    const deps: AskDeps = {
      // 検索範囲は毎回 registry から読む(all_visible 有効時は定期同期で差し替わる・ADR-0036)。
      getRepos: () => registry.scope(),
      syncer,
      // リポ単位の同期(ADR-0036 D5)を常に使う: TTL 内は fetch せず再利用し、同期に失敗しても
      // 許容期間内なら前回データで検索する(段階 1-2)。同期・検索・鮮度確認の書き込みは同じ
      // SerialQueue で直列化されている(discord.ts の handleAsk と freshness の runExclusive)。
      perRepo: { registry, ttlMs: askSyncTtlMs, maxStalenessMs: askSyncMaxStalenessMs },
      promptStore,
      store,
      clonesDir: env.CLONES_DIR,
      search,
      newId: () => randomUUID(),
      now: () => isoJst(),
      logError: (err) =>
        withCorrelation(logger, ctx.correlationId).error({ err }, "/ask pipeline error"),
      logWarn: (data, msg) => withCorrelation(logger, ctx.correlationId).warn(data, msg),
      searchTimeoutMs: effectiveAskTimeoutMs,
      // ADR-0035 追記: 正常終了の猶予を超えたら検索を中断する。
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      // ADR-0035 D5: discord 側の進捗表示へ sync/search/tool_use を流す。
      ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
      ...(discordSearch !== undefined ? { discordSearch } : {}),
    };
    return handleAskRequest(
      {
        question,
        discordUserId: ctx.userId,
        discordChannelId: ctx.channelId,
        threadId: null,
        correlationId: ctx.correlationId,
      },
      deps,
    );
  };

  // §6.4 ③-b voice-memo の STT(ADR-0015)。キー未設定なら機能 OFF(検知が有効ならその旨警告)。
  let transcriber: Transcriber | undefined;
  if (env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY.length > 0) {
    // STT のリトライは 1 回に絞る(withRetry 既定の 3 だと 120s タイムアウト × 4 = 最悪 480s/
    // チャンクを、pending が残る限り kick のたびに払い続ける)。
    transcriber = createOpenAiTranscriber({
      apiKey: env.OPENAI_API_KEY,
      retry: { maxRetries: 1 },
    });
  } else if (voice.channel_id !== null) {
    logger.warn(
      "voice.yaml は設定されていますが OPENAI_API_KEY が無いため文字起こしは行われません(受付のみ・ADR-0015)。",
    );
  }

  // ワーカーは client 依存(返信・DM)のため createBot 後に生成し、hook は遅延参照にする。
  let voiceWorker: { kick(): void } | undefined;
  // §6.4 ③-b(ADR-0020): VC 録音は vc_channel_id + RECORDER_URL が揃ったときだけ有効。
  const vcEnabled = voice.vc_channel_id !== null && env.RECORDER_URL !== undefined;
  let vcWatcher: VcRecorderWatcher | undefined;

  // ADR-0028 D5: /interview は VC 録音が有効な環境でのみ配線(未注入ならコマンド登録もしない)。
  const interviewDeps: InterviewCommandDeps | undefined =
    vcEnabled && voice.vc_channel_id !== null
      ? {
          store,
          voiceVcChannelId: voice.vc_channel_id,
          ...(gh !== undefined ? { gh } : {}),
          ...(ops.kb_repo !== null ? { kbRepo: ops.kb_repo } : {}),
          armTtlMinutes: voice.interview_arm_ttl_minutes,
          maxRecordingMinutes: voice.max_recording_minutes,
          // watcher は createBot 後に生成されるため遅延参照(vcRecorder と同じ流儀)。
          hasActiveRecording: () => vcWatcher?.hasActive() ?? false,
          abortActiveRecording: (reason: string) =>
            vcWatcher?.abortActive(reason) ?? Promise.resolve(),
          makeId: () => randomUUID(),
          now: () => new Date(),
          logger,
        }
      : undefined;

  // ADR-0028 UI: 面談パネルは /interview 配線 + interview_panel_channel_id の環境でのみ有効。
  // client は createBot 後に確定するため遅延参照(vcWatcher と同じ流儀)。
  let clientForPanel: Client | undefined;
  const panelDeps: InterviewPanelDeps | undefined =
    interviewDeps !== undefined && voice.interview_panel_channel_id !== null
      ? {
          commands: interviewDeps,
          panelChannelId: voice.interview_panel_channel_id,
          // VC 内蔵テキストチャットも isTextBased() = true。ガードは ensurePanel/refreshPanel が持つ。
          fetchChannel: async (id: string): Promise<PanelChannel | null> => {
            const client = clientForPanel;
            if (client === undefined) return null;
            const ch =
              client.channels.cache.get(id) ?? (await client.channels.fetch(id).catch(() => null));
            if (ch === null || ch === undefined || !ch.isTextBased() || ch.isDMBased()) return null;
            return ch;
          },
          getMembers,
          loadTopics: () =>
            loadInterviewTopics((p) => fsReadFile(p, "utf8"), join(env.CLONES_DIR, kbDir), logger),
        }
      : undefined;

  // ADR-0040: 📢 共有の投稿先(ホームチャンネル優先・無ければ通知チャンネル)。
  const shareChannelId = ops.home_channel_ids[0] ?? ops.channel_id;
  const bot = createBot({
    logger,
    queue,
    lifecycle: askLifecycle,
    channels,
    store,
    onAsk,
    // ADR-0035 D5: 進捗文面の「上限 N 秒」を実効タイムアウトと一致させる。
    askTimeoutMs: effectiveAskTimeoutMs,
    guildId: env.DISCORD_GUILD_ID,
    ops,
    gh,
    // §6.4 💡 捕捉: owner 写像 + triage/draft プロンプト + Agent SDK cwd(kb_repo/gh が無ければ OFF)。
    getMembers,
    promptStore,
    clonesDir: env.CLONES_DIR,
    // §6.4 ③-b voice-memo: 検知・受付(channel_id が null なら OFF・PR-V1)+ 受付後の起床(PR-V3)。
    voice,
    onVoiceMemoQueued: () => voiceWorker?.kick(),
    // §6.7: 鮮度確認 DM への 👍✏️🗑 応答(undefined なら OFF)。
    ...(freshness !== undefined ? { freshness } : {}),
    // §6.4 ③-b(ADR-0020): VC 録音(watcher は messenger 依存のため遅延参照)。
    ...(vcEnabled
      ? {
          vcRecorder: {
            handleSnapshot: (s: VcSnapshot) => vcWatcher?.handleSnapshot(s) ?? Promise.resolve(),
          },
        }
      : {}),
    // ADR-0028 D5: /interview は VC 録音が有効な環境でのみ配線(未注入ならコマンド登録もしない)。
    ...(interviewDeps !== undefined ? { interview: interviewDeps } : {}),
    // ADR-0028 UI: 面談パネルのコンポーネント応答(未注入なら無反応)。
    ...(panelDeps !== undefined ? { interviewPanel: panelDeps } : {}),
    // ADR-0038 D5: /ask の Discord 本文検索の範囲(本文インデックスが有効なときだけ)。
    ...(discordIndexStore !== undefined
      ? { discordSearchScope: (i) => searchScopeFromInteraction(i, channels) }
      : {}),
    // ADR-0040: 📢 共有の投稿先。ホームチャンネル(ops.home_channel_ids の先頭・#knowledge_sharing)を優先し、
    // 未設定なら従来の通知チャンネル(ops.channel_id)。どちらも無ければ 📢 を出さない。
    ...(shareChannelId !== null ? { shareChannelId, sharedAnswers: store } : {}),
  });
  clientForPanel = bot;
  // ADR-0038 D3: Discord 本文インデックスの同期(イベント + 起動時の取り込み + 定期照合)。
  // 定期照合のタイマーは正常終了(ADR-0035 追記)で止めるため保持する。
  let discordIndexTimer: ReturnType<typeof setInterval> | undefined;
  if (discordIndexStore !== undefined) {
    const indexLogger = logger.child({ component: "discord-index" });
    const indexSync = createDiscordIndexSync({
      store: discordIndexStore,
      source: createDiscordIndexSource(bot),
      channels,
      config: discordIndexConfig,
      logger: {
        info: (data, msg) => indexLogger.info(data, msg),
        warn: (data, msg) => indexLogger.warn(data, msg),
      },
    });
    attachDiscordIndexListeners(bot, indexSync, {
      info: (data, msg) => indexLogger.info(data, msg),
      warn: (data, msg) => indexLogger.warn(data, msg),
    });
    const runCycle = (): void => {
      void indexSync.runCycle().catch((err: unknown) => {
        indexLogger.warn({ err }, "discord-index: 同期に失敗しました(次の周期で再試行)");
      });
    };
    bot.once(Events.ClientReady, () => {
      runCycle();
      discordIndexTimer = setInterval(
        runCycle,
        discordIndexConfig.reconcile_interval_hours * 3_600_000,
      );
      discordIndexTimer.unref();
    });
    indexLogger.info(
      {
        backfillDays: discordIndexConfig.backfill_days,
        retentionDays: discordIndexConfig.retention_days,
        reconcileIntervalHours: discordIndexConfig.reconcile_interval_hours,
        reconcileWindowDays: discordIndexConfig.reconcile_window_days,
        maxToolCalls: discordIndexConfig.max_tool_calls,
        maxResults: discordIndexConfig.max_results,
        excerptChars: discordIndexConfig.excerpt_chars,
      },
      "Discord 本文インデックスは有効です(ADR-0038)",
    );
  }
  const messenger = createClientMessenger(bot);
  const memoWorker = createVoiceMemoWorker({
    logger,
    store,
    getMembers,
    ops,
    ...(gh !== undefined ? { gh } : {}),
    promptStore,
    cwd: env.CLONES_DIR,
    ...(transcriber !== undefined ? { transcriber } : {}),
    messenger,
  });
  // ADR-0028 D4: interview セッションの STT 結合 → 原本 PR。voice worker と同じ kick で起きる
  // (受付 hook・起動時レジューム・completeSession の onQueued を共有)。
  const interviewWorker = createInterviewSessionWorker({
    logger,
    store,
    getMembers,
    ops,
    ...(gh !== undefined ? { gh } : {}),
    ...(transcriber !== undefined ? { transcriber } : {}),
    messenger,
  });
  voiceWorker = {
    kick: () => {
      memoWorker.kick();
      interviewWorker.kick();
    },
  };
  if (vcEnabled && voice.vc_channel_id !== null && env.RECORDER_URL !== undefined) {
    const vcChannelId = voice.vc_channel_id;
    // ADR-0028 D1: interview セッションへのチャンク紐付け。パネル有効時はチャンク境界
    // (claim/commit/drop/complete)ごとにパネルを更新するデコレータを被せる(失敗 warn のみ)。
    const chunkBinding = createInterviewChunkBinding({
      store,
      now: () => new Date(),
      armTtlMinutes: voice.interview_arm_ttl_minutes,
      onQueued: () => voiceWorker?.kick(),
      logger,
    });
    vcWatcher = createVcRecorderWatcher({
      vcChannelId,
      recordingsDir: env.RECORDINGS_DIR,
      client: createRecorderClient(env.RECORDER_URL),
      store,
      dm: messenger.dm,
      onQueued: () => voiceWorker?.kick(),
      makeId: () => randomUUID(),
      now: () => new Date(),
      logger,
      maxMinutes: voice.max_recording_minutes,
      // ADR-0028 D2/D3: 上限 rotation・再起動 resume が現在参加者を取り直す。
      fetchSnapshot: async () => {
        const ch =
          bot.channels.cache.get(vcChannelId) ??
          (await bot.channels.fetch(vcChannelId).catch(() => null));
        if (ch === null || ch === undefined || !ch.isVoiceBased()) return null;
        return buildVcSnapshot(ch, ch.guild.id, vcChannelId);
      },
      chunkBinding:
        panelDeps !== undefined
          ? bindingWithPanelRefresh(chunkBinding, () => refreshPanel(panelDeps), logger)
          : chunkBinding,
    });
  }
  // ADR-0030 D4: VC 入室には通知先(元メッセージ)が無いため、機能 OFF は起動ログで可視化する。
  // 「VC に入ったのに録音されない」の原因が設定漏れだと管理者が気づけるようにする。
  logger.info({ vcRecorder: vcEnabled }, "VC 録音入口(ADR-0020)");
  if (!vcEnabled) {
    logger.warn(
      {
        vcChannelId: voice.vc_channel_id !== null,
        recorderUrl: env.RECORDER_URL !== undefined,
      },
      "VC 録音は未設定です(voice.yaml の vc_channel_id と RECORDER_URL が両方必要・ADR-0020)。VC に入っても録音・文字起こしは行われません。",
    );
  }

  // §6.7(ADR-0019 D2): checker(VM timer)が積んだ鮮度確認 pending を DM で送る worker。
  // checker は日次(平日 11:00 JST)なので、起動時 + 定期ポーリングで拾えば十分。
  const freshnessWorker = createFreshnessDmWorker({ logger, store, dm: messenger.dm });
  const FRESHNESS_POLL_MS = 10 * 60 * 1000;
  const freshnessTimer = setInterval(() => freshnessWorker.kick(), FRESHNESS_POLL_MS);
  freshnessTimer.unref();

  // ADR-0036 D4/D5: 定期同期(all_visible 有効時のみ)と対象外 clone の削除。終了処理が始まったら
  // (/ask の受付停止)新しいリポ・チャンクへ進まず、bot.db にも触らない(DB を閉じた後に書かない)。
  const cleanupDeps: CloneCleanupDeps = {
    store,
    clonesDir: env.CLONES_DIR,
    // repos: の手動指定と KB の dir は managed の記録があっても消さない。
    protectedDirs: [...reposConfig.repos.map((r) => r.dir), kbDir],
    fs: nodeCloneFs,
    logger,
    isStopped: () => !askLifecycle.accepting,
  };
  let periodicSync: PeriodicRepoSync | undefined;
  if (allVisible !== null) {
    periodicSync = createPeriodicRepoSync({
      registry,
      syncer,
      resolveScope: () => resolveScopeOnce(scopeDeps),
      enqueue: (task) => queue.enqueue(task),
      cleanup: cleanupDeps,
      logger,
    });
    const intervalMs = parsePositiveIntEnv(
      "REPO_SYNC_INTERVAL_MS",
      env.REPO_SYNC_INTERVAL_MS,
      DEFAULT_REPO_SYNC_INTERVAL_MS,
      (data, msg) => logger.warn(data, msg),
    );
    periodicSync.start(intervalMs);
    logger.info({ intervalMs }, "all_visible の定期同期を有効化しました(ADR-0036 D5)");
  }

  // 起動時レジューム(ADR-0015 D5): 再起動前に受け付けた pending を拾う。
  bot.once(Events.ClientReady, () => {
    // ADR-0035 追記: 強制終了で残った /ask の進捗表示を「中断しました」に書き換える(15 分以内のみ)。
    // interaction webhook は bot の認証を使わない(auth:false)。token はログに出さない。
    void recoverInterruptedAsks({
      rows: strandedAsks,
      store,
      nowMs: () => Date.now(),
      editOriginal: (applicationId, token, content) =>
        bot.rest.patch(Routes.webhookMessage(applicationId, token, "@original"), {
          body: { content, components: [] },
          auth: false,
        }),
      content: INTERRUPTED_MESSAGE,
      log: lifecycleLog,
    }).catch((err) =>
      logger.warn({ err: safeErrorInfo(err) }, "/ask: 中断した質問の後始末に失敗しました"),
    );
    if (periodicSync !== undefined) {
      // ADR-0036 D5: 初回 clone はバックグラウンド(チャンク単位でキューに積む)。clone できたリポから
      // 検索対象になる。起動時の列挙に成功していればその結果を使う(失敗なら再列挙)。
      void periodicSync.runOnce(startupScope !== null ? { scope: startupScope } : undefined);
    } else if (store.listManagedClones().length > 0) {
      // all_visible を外した(ロールバック)後: bot が作った clone は範囲外なので一度だけ片付ける
      // (agent の cwd は CLONES_DIR のため、残すと manifest に無くても読める)。
      void queue
        .enqueue(() => removeOutOfScopeClones(registry.scope(), cleanupDeps))
        .catch((err: unknown) => logger.warn({ err }, "managed clone の片付けに失敗しました"));
    }
    voiceWorker?.kick();
    freshnessWorker.kick();
    // ADR-0028 D1: state:"recording" の interview セッションを復元(冪等 finalize → 次チャンク/完了)。
    void vcWatcher?.resume();
    // ADR-0028 UI: 常設の面談パネルを設置/復元する(失敗 warn のみ)。
    if (panelDeps !== undefined) void ensurePanel(panelDeps);
    // discord.js 14.x: 未キャッシュ DM へのリアクションは MessageReactionAdd が発火しない
    // (warmDmChannels の docblock 参照)。再起動前に送った DM への 👍✏️🗑 応答を生かす。
    void warmDmChannels(bot, getMembers, logger);
  });

  // ADR-0035 追記: 正常終了(docker stop の SIGTERM・Ctrl-C の SIGINT)。/ask の受付を止めて
  // 最大 SHUTDOWN_GRACE_MS 待ち、残りを中断して通知・記録してから切断する。compose の
  // stop_grace_period(90 秒)は grace(既定 60 秒)+ 中断後の後処理(15 秒)より長くしておく。
  const onShutdownSignal = createShutdownHandler({
    lifecycle: askLifecycle,
    stopTimers: () => {
      clearInterval(freshnessTimer);
      // ADR-0036 D5: 定期同期のタイマを止め、実行中の回は次のリポの前で打ち切る(以後 bot.db に触らない)。
      periodicSync?.stop();
      if (discordIndexTimer !== undefined) clearInterval(discordIndexTimer);
      // ADR-0042: 待機中・準備中の subprocess を閉じる(/ask の終了処理の後なので新たには用意されない)。
      return askPrewarm?.dispose();
    },
    destroyClient: () => bot.destroy(),
    closeStore: () => {
      store.close();
      // ADR-0038: Discord 本文インデックス(別ファイル)も閉じる。
      discordIndexStore?.close();
    },
    exit: (code) => process.exit(code),
    log: lifecycleLog,
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      void onShutdownSignal(sig);
    });
  }

  await bot.login(env.DISCORD_TOKEN);
  logger.info("discord-bot started");
}

main().catch((err) => {
  // 原因(cause)まで 1 行で出す。資格情報・トークンは describeError が伏せる(§9.1)。
  console.error("fatal:", describeError(err));
  process.exitCode = 1;
});
