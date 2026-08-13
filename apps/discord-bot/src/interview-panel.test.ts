import type { Members } from "@stratum/kb-core";
import type {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./db.js";
import type { InterviewCommandDeps } from "./interview-commands.js";
import {
  bindingWithPanelRefresh,
  buildPanelEmbed,
  CUSTOM_TOPIC_VALUE,
  ensurePanel,
  findPanelLedger,
  handleInterviewPanelButton,
  handleInterviewPersonSelect,
  handleInterviewTopicModal,
  handleInterviewTopicSelect,
  INTERVIEW_PANEL_ACTION_TYPE,
  type InterviewPanelDeps,
  type PanelChannel,
  type PanelMessageOptions,
  panelComponents,
  parseInterviewCustomId,
  refreshPanel,
  topicCustomId,
  topicModalCustomId,
} from "./interview-panel.js";
import {
  INTERVIEW_SESSION_ACTION_TYPE,
  type InterviewChunk,
  type InterviewChunkBinding,
  type InterviewSessionPayload,
  interviewSessionPayloadSchema,
} from "./interview-session.js";
import type { InterviewTopicOption } from "./interview-topics.js";

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const NOW = new Date("2026-08-13T03:00:00Z"); // = 12:00 JST
const VC = "222222222222222222";
const PANEL_CH = "333333333333333333";

function samplePayload(over: Partial<InterviewSessionPayload> = {}): InterviewSessionPayload {
  return {
    sessionId: "sess-1",
    person: "山田",
    topic: "リリース手順",
    kitPath: null,
    guildId: "G1",
    channelId: VC,
    starterId: "U-starter",
    participantIds: [],
    chunks: [],
    currentChunk: null,
    startedAtJst: "2026-08-13T11:30:00+09:00", // NOW の 30 分前
    ...over,
  };
}

function seedSession(
  store: ReturnType<typeof createMemoryStore>,
  state: string,
  payload: InterviewSessionPayload = samplePayload(),
): void {
  store.queueAction({
    id: "act-1",
    type: INTERVIEW_SESSION_ACTION_TYPE,
    queryId: null,
    payloadJson: JSON.stringify(payload),
    state,
    createdAt: "t",
  });
}

function seedLedger(
  store: ReturnType<typeof createMemoryStore>,
  messageId: string,
  channelId: string = PANEL_CH,
): void {
  store.queueAction({
    id: "panel-1",
    type: INTERVIEW_PANEL_ACTION_TYPE,
    queryId: null,
    payloadJson: JSON.stringify({ channelId, messageId }),
    state: "pending",
    createdAt: "t",
  });
}

function mkPanel(
  opts: {
    members?: Members;
    topics?: InterviewTopicOption[];
    fetchFails?: boolean;
    channelMissing?: boolean;
    textBased?: boolean;
    commandsOver?: Partial<InterviewCommandDeps>;
  } = {},
): {
  deps: InterviewPanelDeps;
  store: ReturnType<typeof createMemoryStore>;
  sends: PanelMessageOptions[];
  edits: PanelMessageOptions[];
  fetchedMessageIds: string[];
} {
  const store = createMemoryStore();
  let seq = 0;
  const commands: InterviewCommandDeps = {
    store,
    voiceVcChannelId: VC,
    armTtlMinutes: 120,
    maxRecordingMinutes: 15,
    hasActiveRecording: () => false,
    abortActiveRecording: async () => {},
    makeId: () => `id-${++seq}`,
    now: () => NOW,
    logger,
    ...opts.commandsOver,
  };
  const sends: PanelMessageOptions[] = [];
  const edits: PanelMessageOptions[] = [];
  const fetchedMessageIds: string[] = [];
  const channel: PanelChannel = {
    isTextBased: () => opts.textBased ?? true,
    messages: {
      fetch: async (messageId) => {
        fetchedMessageIds.push(messageId);
        if (opts.fetchFails === true) throw new Error("Unknown Message");
        return {
          edit: async (o) => {
            edits.push(o);
          },
        };
      },
    },
    send: async (o) => {
      sends.push(o);
      return { id: `msg-${sends.length}` };
    },
  };
  const deps: InterviewPanelDeps = {
    commands,
    panelChannelId: PANEL_CH,
    fetchChannel: async () => (opts.channelMissing === true ? null : channel),
    getMembers: async () =>
      opts.members ?? { members: [{ github: "yamada", name: "山田 太郎", discord: "U-1" }] },
    loadTopics: async () => opts.topics ?? [{ value: "release", label: "リリース手順" }],
  };
  return { deps, store, sends, edits, fetchedMessageIds };
}

/** void refreshPanel(...) 等の fire-and-forget を待つ。 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// --- fake interactions(interview-commands.test.ts と同じ流儀)---

function fakeButton(customId: string): {
  interaction: ButtonInteraction;
  replies: { content?: string; components?: unknown[]; ephemeral?: boolean }[];
} {
  const replies: { content?: string; components?: unknown[]; ephemeral?: boolean }[] = [];
  const interaction = {
    customId,
    replied: false,
    deferred: false,
    reply: async (o: { content?: string; components?: unknown[]; ephemeral?: boolean }) => {
      replies.push(o);
      (interaction as { replied: boolean }).replied = true;
    },
  };
  return { interaction: interaction as unknown as ButtonInteraction, replies };
}

function fakeUserSelect(
  customId: string,
  values: string[],
): {
  interaction: UserSelectMenuInteraction;
  updates: { content?: string; components?: unknown[] }[];
} {
  const updates: { content?: string; components?: unknown[] }[] = [];
  const interaction = {
    customId,
    values,
    replied: false,
    deferred: false,
    update: async (o: { content?: string; components?: unknown[] }) => {
      updates.push(o);
      (interaction as { replied: boolean }).replied = true;
    },
    reply: async () => {},
  };
  return { interaction: interaction as unknown as UserSelectMenuInteraction, updates };
}

function fakeStringSelect(
  customId: string,
  values: string[],
  guildId: string | null = "G1",
): {
  interaction: StringSelectMenuInteraction;
  updates: { content?: string; components?: unknown[] }[];
  modals: ModalBuilder[];
} {
  const updates: { content?: string; components?: unknown[] }[] = [];
  const modals: ModalBuilder[] = [];
  const interaction = {
    customId,
    values,
    guildId,
    user: { id: "U-starter" },
    replied: false,
    deferred: false,
    update: async (o: { content?: string; components?: unknown[] }) => {
      updates.push(o);
      (interaction as { replied: boolean }).replied = true;
    },
    showModal: async (m: ModalBuilder) => {
      modals.push(m);
    },
    reply: async () => {},
  };
  return { interaction: interaction as unknown as StringSelectMenuInteraction, updates, modals };
}

function fakeModalSubmit(
  customId: string,
  topicValue: string,
  guildId: string | null = "G1",
): {
  interaction: ModalSubmitInteraction;
  replies: { content?: string; ephemeral?: boolean }[];
} {
  const replies: { content?: string; ephemeral?: boolean }[] = [];
  const interaction = {
    customId,
    guildId,
    user: { id: "U-starter" },
    replied: false,
    deferred: false,
    fields: {
      getTextInputValue: (id: string) => (id === "topic" ? topicValue : ""),
    },
    reply: async (o: { content?: string; ephemeral?: boolean }) => {
      replies.push(o);
      (interaction as { replied: boolean }).replied = true;
    },
  };
  return { interaction: interaction as unknown as ModalSubmitInteraction, replies };
}

const embedField = (options: PanelMessageOptions): string =>
  options.embeds[0]?.data.fields?.[0]?.value ?? "";

describe("buildPanelEmbed(常設 embed の 3 態)", () => {
  it("セッション無し: 開始できる旨を表示する", () => {
    const embed = buildPanelEmbed(null, NOW, 120);
    expect(embed.data.title).toBe("🎙 ナレッジインタビュー");
    expect(embed.data.description).toContain("面談を開始");
    expect(embed.data.fields?.[0]?.name).toBe("状態");
    expect(embed.data.fields?.[0]?.value).toContain("セッション無し");
  });

  it("armed: 対象者・テーマ・自動キャンセルまでの残分を表示する", () => {
    const embed = buildPanelEmbed({ payload: samplePayload(), state: "armed" }, NOW, 120);
    const value = embed.data.fields?.[0]?.value ?? "";
    expect(value).toContain("armed(VC 入室待ち): 山田 × リリース手順");
    expect(value).toContain("残り 90 分"); // TTL 120 - 経過 30
  });

  it("recording: 対象者・テーマ・チャンク数・経過分を表示する", () => {
    const chunk: InterviewChunk = {
      seq: 1,
      meetingId: "vm-1",
      filePath: "/r/vm-1/recording.m4a",
      recordedAtJst: "2026-08-13T11:45:00+09:00",
      transcript: null,
    };
    const embed = buildPanelEmbed(
      { payload: samplePayload({ chunks: [chunk, { ...chunk, seq: 2 }] }), state: "recording" },
      NOW,
      120,
    );
    const value = embed.data.fields?.[0]?.value ?? "";
    expect(value).toContain("recording(録音中): 山田 × リリース手順");
    expect(value).toContain("チャンク: 2 本 / 経過: 30 分");
    expect(value).not.toContain("自動キャンセルまで");
  });
});

describe("customId(round-trip とボタン行)", () => {
  it("topic / topicModal は personId 込みで round-trip する", () => {
    expect(parseInterviewCustomId(topicCustomId("U-1"))).toEqual({
      kind: "topic",
      personId: "U-1",
    });
    expect(parseInterviewCustomId(topicModalCustomId("U-1"))).toEqual({
      kind: "topicModal",
      personId: "U-1",
    });
  });

  it("固定 customId(open/status/cancel/person)を解析し、対象外は null", () => {
    expect(parseInterviewCustomId("interview:open")).toEqual({ kind: "open" });
    expect(parseInterviewCustomId("interview:status")).toEqual({ kind: "status" });
    expect(parseInterviewCustomId("interview:cancel")).toEqual({ kind: "cancel" });
    expect(parseInterviewCustomId("interview:person")).toEqual({ kind: "person" });
    expect(parseInterviewCustomId("fb:up:q1")).toBeNull();
    expect(parseInterviewCustomId("interview:unknown")).toBeNull();
    expect(parseInterviewCustomId("interview:topic:")).toBeNull(); // personId 空は不正
  });

  it("panelComponents: 開始(Primary)/ 状況(Secondary)/ 中止(Danger)の 3 ボタン", () => {
    const row = panelComponents().toJSON();
    expect(row.components.map((c) => ("custom_id" in c ? c.custom_id : ""))).toEqual([
      "interview:open",
      "interview:status",
      "interview:cancel",
    ]);
  });
});

describe("ensurePanel(常設 1 枚の維持と台帳 upsert)", () => {
  it("台帳が無ければ新規投稿して台帳 1 行を state pending で作る", async () => {
    const { deps, store, sends } = mkPanel();
    await ensurePanel(deps);
    expect(sends).toHaveLength(1);
    expect(embedField(sends[0] as PanelMessageOptions)).toContain("セッション無し");
    const rows = store.listPendingActions(INTERVIEW_PANEL_ACTION_TYPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("pending");
    expect(findPanelLedger(store)).toEqual({
      id: "id-1",
      channelId: PANEL_CH,
      messageId: "msg-1",
    });
  });

  it("台帳があり fetch 成功なら既存メッセージを edit する(再投稿しない)", async () => {
    const { deps, store, sends, edits, fetchedMessageIds } = mkPanel();
    seedLedger(store, "m-9");
    seedSession(store, "armed");
    await ensurePanel(deps);
    expect(fetchedMessageIds).toEqual(["m-9"]);
    expect(edits).toHaveLength(1);
    expect(embedField(edits[0] as PanelMessageOptions)).toContain("armed");
    expect(sends).toHaveLength(0);
    expect(findPanelLedger(store)?.messageId).toBe("m-9"); // 台帳は据え置き
  });

  it("fetch 失敗(パネル削除済み)は再投稿して台帳を setActionPayload で差し替える", async () => {
    const { deps, store, sends } = mkPanel({ fetchFails: true });
    seedLedger(store, "m-deleted");
    await ensurePanel(deps);
    expect(sends).toHaveLength(1);
    const rows = store.listPendingActions(INTERVIEW_PANEL_ACTION_TYPE);
    expect(rows).toHaveLength(1); // 1 行のまま upsert
    expect(rows[0]?.state).toBe("pending");
    expect(findPanelLedger(store)).toEqual({
      id: "panel-1",
      channelId: PANEL_CH,
      messageId: "msg-1",
    });
  });

  it("チャンネルが取得できない・テキスト非対応なら何もしない(warn のみ)", async () => {
    const missing = mkPanel({ channelMissing: true });
    await ensurePanel(missing.deps);
    expect(missing.sends).toHaveLength(0);
    expect(missing.store.listPendingActions(INTERVIEW_PANEL_ACTION_TYPE)).toHaveLength(0);

    const notText = mkPanel({ textBased: false });
    await ensurePanel(notText.deps);
    expect(notText.sends).toHaveLength(0);
  });
});

describe("refreshPanel(セッション状態への追従)", () => {
  it("台帳のメッセージを現在のセッション状態で edit する", async () => {
    const { deps, store, edits } = mkPanel();
    seedLedger(store, "m-1");
    seedSession(store, "recording");
    await refreshPanel(deps);
    expect(edits).toHaveLength(1);
    expect(embedField(edits[0] as PanelMessageOptions)).toContain("recording");
  });

  it("台帳が無ければ no-op(設置は ensurePanel の仕事)", async () => {
    const { deps, sends, edits } = mkPanel();
    await refreshPanel(deps);
    expect(sends).toHaveLength(0);
    expect(edits).toHaveLength(0);
  });

  it("fetch 失敗は warn のみで落ちない(呼び手の録音処理を阻害しない)", async () => {
    const { deps, store } = mkPanel({ fetchFails: true });
    seedLedger(store, "m-1");
    await expect(refreshPanel(deps)).resolves.toBeUndefined();
  });
});

describe("handleInterviewPanelButton(open / status / cancel)", () => {
  it("open: 対象者の UserSelectMenu を ephemeral で出す", async () => {
    const { deps } = mkPanel();
    const { interaction, replies } = fakeButton("interview:open");
    await handleInterviewPanelButton(interaction, deps);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.ephemeral).toBe(true);
    const row = (replies[0]?.components?.[0] as ActionRowBuilder<StringSelectMenuBuilder>).toJSON();
    expect(row.components[0] && "custom_id" in row.components[0]).toBe(true);
    expect(
      row.components[0] && "custom_id" in row.components[0] ? row.components[0].custom_id : "",
    ).toBe("interview:person");
  });

  it("status: statusInterviewCore の文言を ephemeral で返す", async () => {
    const { deps } = mkPanel();
    const { interaction, replies } = fakeButton("interview:status");
    await handleInterviewPanelButton(interaction, deps);
    expect(replies[0]).toEqual({ content: "進行中のセッションはありません。", ephemeral: true });
  });

  it("cancel: セッションを中止してパネルを更新する", async () => {
    const { deps, store, edits } = mkPanel();
    seedLedger(store, "m-1");
    seedSession(store, "armed");
    const { interaction, replies } = fakeButton("interview:cancel");
    await handleInterviewPanelButton(interaction, deps);
    expect(replies[0]?.content).toContain("中止しました");
    expect(replies[0]?.ephemeral).toBe(true);
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.state).toBe("cancelled");
    await tick();
    expect(edits).toHaveLength(1); // void refreshPanel が embed を更新
    expect(embedField(edits[0] as PanelMessageOptions)).toContain("セッション無し");
  });

  it("interview: 以外の customId には反応しない", async () => {
    const { deps } = mkPanel();
    const { interaction, replies } = fakeButton("fb:up:q1");
    await handleInterviewPanelButton(interaction, deps);
    expect(replies).toHaveLength(0);
  });

  it("store が throw しても封じ込めてガード付きで通知する", async () => {
    const broken = mkPanel();
    broken.deps.commands.store = {
      ...broken.store,
      listPendingActions: () => {
        throw new Error("sqlite locked");
      },
    };
    const { interaction, replies } = fakeButton("interview:status");
    await handleInterviewPanelButton(interaction, broken.deps);
    expect(replies[0]).toEqual({ content: "操作の処理に失敗しました。", ephemeral: true });
  });
});

describe("handleInterviewPersonSelect(対象者 → テーマ選択へ更新)", () => {
  it("同じ ephemeral をテーマ選択に更新する(先頭は「その他」・候補は expertise 由来)", async () => {
    const { deps } = mkPanel({
      topics: [
        { value: "release", label: "リリース手順" },
        { value: "sre", label: "SRE 運用" },
      ],
    });
    const { interaction, updates } = fakeUserSelect("interview:person", ["U-1"]);
    await handleInterviewPersonSelect(interaction, deps);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.content).toContain("<@U-1>");
    const row = (updates[0]?.components?.[0] as ActionRowBuilder<StringSelectMenuBuilder>).toJSON();
    const menu = row.components[0];
    if (menu === undefined || !("options" in menu)) throw new Error("menu missing");
    expect(menu.custom_id).toBe(topicCustomId("U-1"));
    expect(menu.options.map((o) => o.value)).toEqual([CUSTOM_TOPIC_VALUE, "release", "sre"]);
    expect(menu.options[0]?.label).toContain("その他");
  });

  it("expertise が読めない環境でも「その他」だけで出す", async () => {
    const { deps } = mkPanel({ topics: [] });
    const { interaction, updates } = fakeUserSelect("interview:person", ["U-1"]);
    await handleInterviewPersonSelect(interaction, deps);
    const row = (updates[0]?.components?.[0] as ActionRowBuilder<StringSelectMenuBuilder>).toJSON();
    const menu = row.components[0];
    if (menu === undefined || !("options" in menu)) throw new Error("menu missing");
    expect(menu.options.map((o) => o.value)).toEqual([CUSTOM_TOPIC_VALUE]);
  });

  it("customId が interview:person 以外なら反応しない", async () => {
    const { deps } = mkPanel();
    const { interaction, updates } = fakeUserSelect("other:person", ["U-1"]);
    await handleInterviewPersonSelect(interaction, deps);
    expect(updates).toHaveLength(0);
  });
});

describe("handleInterviewTopicSelect(テーマ選択 → 開始 / その他 → モーダル)", () => {
  it("リスト選択で即 start(person は members で解決・topic は topic キー)", async () => {
    const { deps, store } = mkPanel();
    const { interaction, updates } = fakeStringSelect(topicCustomId("U-1"), ["release"]);
    await handleInterviewTopicSelect(interaction, deps);

    const actions = store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.state).toBe("armed");
    const payload = interviewSessionPayloadSchema.parse(JSON.parse(actions[0]?.payloadJson ?? ""));
    expect(payload).toMatchObject({
      person: "yamada", // U-1 → githubForDiscord
      topic: "release",
      kitPath: null, // gh 未設定: 自動発見はしない(interviewKitPath は resolveKitPath 経由)
      guildId: "G1",
      starterId: "U-starter",
    });
    expect(updates[0]?.content).toContain("yamada × release");
    expect(updates[0]?.components).toEqual([]); // メニューを畳む
  });

  it("members 未登載の対象者は生の Discord ID で開始する", async () => {
    const { deps, store } = mkPanel({ members: { members: [] } });
    const { interaction } = fakeStringSelect(topicCustomId("U-99"), ["release"]);
    await handleInterviewTopicSelect(interaction, deps);
    const payload = interviewSessionPayloadSchema.parse(
      JSON.parse(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.payloadJson ?? ""),
    );
    expect(payload.person).toBe("U-99");
  });

  it("ガード拒否(既にアクティブなセッション)は拒否文言で更新し store に積まない", async () => {
    const { deps, store } = mkPanel();
    seedSession(store, "armed");
    const { interaction, updates } = fakeStringSelect(topicCustomId("U-1"), ["release"]);
    await handleInterviewTopicSelect(interaction, deps);
    expect(updates[0]?.content).toContain("進行中の interview セッション");
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(1); // 追加なし
  });

  it("「その他」はモーダル(TextInput topic 必須)を出し、まだ start しない", async () => {
    const { deps, store } = mkPanel();
    const { interaction, updates, modals } = fakeStringSelect(topicCustomId("U-1"), [
      CUSTOM_TOPIC_VALUE,
    ]);
    await handleInterviewTopicSelect(interaction, deps);
    expect(modals).toHaveLength(1);
    const modal = (modals[0] as ModalBuilder).toJSON();
    expect(modal.custom_id).toBe(topicModalCustomId("U-1"));
    const row = modal.components[0];
    if (row === undefined || !("components" in row)) throw new Error("modal row missing");
    const input = row.components[0];
    expect(input?.custom_id).toBe("topic");
    expect(input?.required).toBe(true);
    expect(updates).toHaveLength(0);
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(0);
  });

  it("guild 外からは開始しない", async () => {
    const { deps, store } = mkPanel();
    const { interaction, updates } = fakeStringSelect(topicCustomId("U-1"), ["release"], null);
    await handleInterviewTopicSelect(interaction, deps);
    expect(updates[0]?.content).toContain("サーバー内でのみ");
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(0);
  });

  it("customId が interview:topic:* 以外なら反応しない", async () => {
    const { deps } = mkPanel();
    const { interaction, updates, modals } = fakeStringSelect("other:menu", ["release"]);
    await handleInterviewTopicSelect(interaction, deps);
    expect(updates).toHaveLength(0);
    expect(modals).toHaveLength(0);
  });
});

describe("handleInterviewTopicModal(自由入力 → 開始)", () => {
  it("入力テーマで start し、結果を ephemeral で返す", async () => {
    const { deps, store, edits } = mkPanel();
    seedLedger(store, "m-1");
    const { interaction, replies } = fakeModalSubmit(topicModalCustomId("U-1"), "新規事業の知見");
    await handleInterviewTopicModal(interaction, deps);
    const payload = interviewSessionPayloadSchema.parse(
      JSON.parse(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)[0]?.payloadJson ?? ""),
    );
    expect(payload).toMatchObject({ person: "yamada", topic: "新規事業の知見" });
    expect(replies[0]?.content).toContain("yamada × 新規事業の知見");
    expect(replies[0]?.ephemeral).toBe(true);
    await tick();
    expect(edits).toHaveLength(1); // void refreshPanel が armed 表示へ更新
    expect(embedField(edits[0] as PanelMessageOptions)).toContain("armed");
  });

  it("空白のみのテーマは開始しない", async () => {
    const { deps, store } = mkPanel();
    const { interaction, replies } = fakeModalSubmit(topicModalCustomId("U-1"), "   ");
    await handleInterviewTopicModal(interaction, deps);
    expect(replies[0]?.content).toContain("テーマが空です");
    expect(store.listPendingActions(INTERVIEW_SESSION_ACTION_TYPE)).toHaveLength(0);
  });

  it("customId が interview:topicModal:* 以外なら反応しない", async () => {
    const { deps } = mkPanel();
    const { interaction, replies } = fakeModalSubmit("other:modal", "テーマ");
    await handleInterviewTopicModal(interaction, deps);
    expect(replies).toHaveLength(0);
  });
});

describe("bindingWithPanelRefresh(チャンク境界でのパネル更新)", () => {
  const chunk: InterviewChunk = {
    seq: 1,
    meetingId: "vm-1",
    filePath: "/r/vm-1/recording.m4a",
    recordedAtJst: "2026-08-13T11:45:00+09:00",
    transcript: null,
  };

  function fakeBinding(): { binding: InterviewChunkBinding; calls: string[] } {
    const calls: string[] = [];
    const binding: InterviewChunkBinding = {
      claimChunk: (meetingId) => {
        calls.push(`claim:${meetingId}`);
        return { sessionActionId: "a-1", seq: 1 };
      },
      commitChunk: (id, c) => {
        calls.push(`commit:${id}:${c.seq}`);
      },
      dropChunk: (id, meetingId) => {
        calls.push(`drop:${id}:${meetingId}`);
      },
      completeSession: (id) => {
        calls.push(`complete:${id}`);
      },
      resumeTarget: () => {
        calls.push("resume");
        return null;
      },
    };
    return { binding, calls };
  }

  it("claim/commit/drop/complete の後に refresh を呼び、結果は素通しする", async () => {
    const { binding, calls } = fakeBinding();
    let refreshed = 0;
    const decorated = bindingWithPanelRefresh(
      binding,
      async () => {
        refreshed += 1;
      },
      logger,
    );
    expect(decorated.claimChunk("vm-1", "t")).toEqual({ sessionActionId: "a-1", seq: 1 });
    decorated.commitChunk("a-1", chunk, ["U-1"]);
    decorated.dropChunk("a-1", "vm-1");
    decorated.completeSession("a-1");
    expect(decorated.resumeTarget()).toBeNull(); // resume は境界ではないので refresh しない
    await tick();
    expect(refreshed).toBe(4);
    expect(calls).toEqual([
      "claim:vm-1",
      "commit:a-1:1",
      "drop:a-1:vm-1",
      "complete:a-1",
      "resume",
    ]);
  });

  it("refresh の失敗は warn のみで録音処理を阻害しない", async () => {
    const warns: unknown[] = [];
    const { binding } = fakeBinding();
    const decorated = bindingWithPanelRefresh(
      binding,
      async () => {
        throw new Error("boom");
      },
      {
        warn: (...args: unknown[]) => {
          warns.push(args);
        },
      },
    );
    expect(() => decorated.completeSession("a-1")).not.toThrow();
    await tick();
    expect(warns).toHaveLength(1);
  });
});
