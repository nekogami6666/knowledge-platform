/**
 * discord-bot エントリポイント(design.md §6.2 C1)。
 * env / config をロードし、SQLite ストア・RepoSyncer・プロンプトローダ・検索パイプラインを
 * 組み立てて /ask を配線し、Discord にログインする。
 */
import { randomUUID } from "node:crypto";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { createGhClientFromEnv, type GhClient } from "@stratum/gh-client";
import { validateRepo } from "@stratum/kb-core";
import {
  createFsPromptStore,
  createOpenAiTranscriber,
  nullUsageRecorder,
  type Transcriber,
} from "@stratum/llm";
import { withCloneToken } from "@stratum/shared";
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
import { resolveRepoScope } from "./repo-scope.js";
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
  const repos = reposConfig.repos.map((r) =>
    r.url !== undefined ? { ...r, url: withCloneToken(r.url, env.GIT_CLONE_TOKEN) } : r,
  );
  const ops = await loadOps(reader);
  const voice = await loadVoice(reader);
  // ADR-0038: Discord 本文インデックス(既定 OFF。OFF なら DB を作らずイベントも購読しない)。
  const discordIndexConfig = await loadDiscordIndex(reader);

  // members 対応表は KB clone の _meta/members.yaml が唯一の正(ADR-0017 D3)。
  // clone 先 dir は repos.yaml の ops.kb_repo 該当エントリから引く(無ければ既定名)。
  const kbDir = repos.find((r) => r.repo === ops.kb_repo)?.dir ?? DEFAULT_KB_DIR;
  // 検索範囲(ADR-0036)。all_visible の列挙・定期同期での差し替えは後続(3b-2)で配線する。
  const registry = createRepoRegistry(
    resolveRepoScope({ manual: repos, allVisible: null, visible: [] }).repos,
  );
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
  if (repos.length === 0) {
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
  const syncer = createGitRepoSyncer(env.CLONES_DIR);
  const promptStore = createFsPromptStore(env.PROMPTS_DIR);
  // §6.2 /ask の直列キュー。鮮度確認の KB 書き込みも同じキューに載せ、検索中の reset --hard・
  // 書き込み途中の同期を起こさない(ADR-0035 の既知レース・ADR-0036 D5)。
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
      // KB clone を触る区間(sync → 書き込み → validate → commit)を /ask と直列化する。
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
  const search = createQaSearch({
    usage: nullUsageRecorder,
    timeoutMs: effectiveAskTimeoutMs,
    ...(askMaxTurns !== undefined ? { maxTurns: askMaxTurns } : {}),
    ...(env.ASK_EFFORT !== undefined ? { effort: env.ASK_EFFORT } : {}),
    ...(env.ASK_THINKING !== undefined ? { thinking: env.ASK_THINKING } : {}),
  });

  const onAsk: AskHandler = (question, ctx) => {
    // ADR-0038 D5/D6: 本文インデックスが有効なら、質問者の検索範囲で discord_search を作る
    // (範囲が判定できない・空ならツールは渡さず、discord 引用は全て破棄される)。
    const discordSearch =
      discordIndexStore !== undefined && ctx.discordScope !== undefined
        ? createDiscordSearchSession({
            store: discordIndexStore,
            scope: ctx.discordScope ?? { guildId: "", channelIds: new Set() },
            maxResults: discordIndexConfig.max_results,
          })
        : undefined;
    const deps: AskDeps = {
      // 検索範囲は毎回 registry から読む(ADR-0036)。
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
      if (discordIndexTimer !== undefined) clearInterval(discordIndexTimer);
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
  // シークレットは出さない(§9.1)。メッセージのみ。
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
