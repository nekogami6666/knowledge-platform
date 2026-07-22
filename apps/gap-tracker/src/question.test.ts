import type { QueryRecord } from "@stratum/discord-bot/store";
import { describe, expect, it } from "vitest";
import type { Assignee } from "./config.js";
import {
  buildQuestion,
  buildRequestMessage,
  containsQueryId,
  isoWeekKey,
  resolveDiscordForGithub,
  resolveGithubForDiscord,
  selectAssignee,
  toBotAnswerQuality,
} from "./question.js";

const query = (over: Partial<QueryRecord> = {}): QueryRecord => ({
  id: "uuid-1",
  correlationId: "c1",
  discordUserId: "111",
  discordChannelId: "222",
  threadId: null,
  question: "分注機 Z の保守周期は?",
  answer: null,
  sourcesJson: null,
  answerStatus: "unanswered",
  feedback: null,
  inputTokens: null,
  outputTokens: null,
  elapsedMs: null,
  createdAt: "2026-07-06T10:00:00+09:00",
  ...over,
});

const yamada: Assignee = { github: "yamada", discord: "999" };

describe("toBotAnswerQuality", () => {
  it("👎 は downvoted、それ以外は unanswered(§4.4)", () => {
    expect(toBotAnswerQuality(query())).toBe("unanswered");
    expect(toBotAnswerQuality(query({ feedback: "down", answerStatus: "answered" }))).toBe(
      "downvoted",
    );
  });
});

describe("buildQuestion", () => {
  it("QuestionLog frontmatter を組み立てる(assignee 有り → status:asked)", () => {
    const b = buildQuestion("q-2026-0090", query(), yamada, () => undefined);
    expect(b.path).toBe("questions/open/q-2026-0090.md");
    expect(b.frontmatter).toEqual({
      id: "q-2026-0090",
      asked_by: "discord:111",
      asked_at: "2026-07-06T10:00:00+09:00",
      channel: "222",
      question: "分注機 Z の保守周期は?",
      bot_answer_quality: "unanswered",
      status: "asked",
      assignee: "yamada",
    });
    expect(b.body).toContain("query-id: uuid-1"); // 冪等キー
    expect(b.body).toContain("出典が見つからず未回答");
  });
  it("assignee 無しは status:open・GitHub 名が引ければ asked_by に使う", () => {
    const b = buildQuestion("q-2026-0091", query(), null, () => "tanaka");
    expect(b.frontmatter.status).toBe("open");
    expect(b.frontmatter.assignee).toBeUndefined();
    expect(b.frontmatter.asked_by).toBe("tanaka");
  });
});

describe("containsQueryId(冪等ガード)", () => {
  it("既存エントリに query-id 行があれば true", () => {
    const raws = ["---\nid: q-2026-0001\n---\n\nquery-id: uuid-1\n"];
    expect(containsQueryId(raws, "uuid-1")).toBe(true);
    expect(containsQueryId(raws, "uuid-2")).toBe(false);
    expect(containsQueryId([], "uuid-1")).toBe(false);
  });
});

describe("selectAssignee(ラウンドロビン + 週3件上限・§6.5 L501)", () => {
  const abc: Assignee[] = [
    { github: "a", discord: "1" },
    { github: "b", discord: "2" },
    { github: "c", discord: "3" },
  ];
  it("startIndex から順に、予約できた最初の人を返す", () => {
    expect(selectAssignee(abc, 1, () => true)?.github).toBe("b");
  });
  it("上限の人は飛ばす(a 満杯 → b)", () => {
    expect(selectAssignee(abc, 0, (g) => g !== "a")?.github).toBe("b");
  });
  it("全員上限なら null", () => {
    expect(selectAssignee(abc, 0, () => false)).toBeNull();
    expect(selectAssignee([], 0, () => true)).toBeNull();
  });
});

describe("isoWeekKey", () => {
  it("ISO 週(月曜始まり)でキー化する", () => {
    expect(isoWeekKey(new Date("2026-07-06T00:00:00Z"))).toBe("2026-W28"); // 月曜
    expect(isoWeekKey(new Date("2026-07-12T00:00:00Z"))).toBe("2026-W28"); // 同週の日曜
    expect(isoWeekKey(new Date("2026-07-13T00:00:00Z"))).toBe("2026-W29"); // 翌週の月曜
  });
});

describe("buildRequestMessage(§6.5 L502 テンプレ)", () => {
  it("メンション・質問・q-ID(返信キー)を含む", () => {
    const m = buildRequestMessage(yamada, "tanaka", "校正手順は?", "q-2026-0090");
    expect(m).toContain("<@999>");
    expect(m).toContain("tanaka さんが「校正手順は?」を探していました");
    expect(m).toContain("1〜2 文で");
    expect(m).toContain("(q-2026-0090)");
  });
});

describe("resolveGithubForDiscord(ADR-0017 D3: members 優先 + assignees フォールバック)", () => {
  const members = { members: [{ github: "alice-gh", discord: "111" }] };
  const assignees: Assignee[] = [{ github: "bob-gh", discord: "222" }];

  it("members.yaml 登載者は members から解決する", () => {
    expect(resolveGithubForDiscord(members, assignees, "111")).toBe("alice-gh");
  });

  it("members 未登載でも assignees(依頼プール)に居れば解決する(移行期フォールバック)", () => {
    expect(resolveGithubForDiscord(members, assignees, "222")).toBe("bob-gh");
  });

  it("どちらにも居なければ undefined(呼び出し側が discord:<id> へフォールバック)", () => {
    expect(resolveGithubForDiscord(members, assignees, "999")).toBeUndefined();
  });

  it("両方に居る場合は members が勝つ(唯一の正)", () => {
    const both = { members: [{ github: "alice-members", discord: "222" }] };
    expect(resolveGithubForDiscord(both, assignees, "222")).toBe("alice-members");
  });
});

describe("resolveDiscordForGithub(ADR-0017 D3: 逆引きも members 優先 + assignees フォールバック)", () => {
  const members = { members: [{ github: "alice-gh", discord: "111" }] };
  const assignees: Assignee[] = [{ github: "bob-gh", discord: "222" }];

  it("members 登載者は members から逆引き", () => {
    expect(resolveDiscordForGithub(members, assignees, "alice-gh")).toBe("111");
  });
  it("members 未登載でも assignees に居れば逆引き", () => {
    expect(resolveDiscordForGithub(members, assignees, "bob-gh")).toBe("222");
  });
  it("どちらにも居なければ undefined", () => {
    expect(resolveDiscordForGithub(members, assignees, "nobody")).toBeUndefined();
  });
  it("両方に居る場合は members が勝つ", () => {
    const both = { members: [{ github: "bob-gh", discord: "999" }] };
    expect(resolveDiscordForGithub(both, assignees, "bob-gh")).toBe("999");
  });
});
