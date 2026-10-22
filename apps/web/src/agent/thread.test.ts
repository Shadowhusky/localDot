import { describe, expect, it } from "vitest";
import {
  AGENT_LIMITS,
  type AgentMessage,
  type AgentQuestion,
  type AgentResult,
  type UsageCall,
} from "./model.ts";
import {
  controlLine,
  type ThreadItem,
  threadItems,
  threadRows,
  timeLabel,
  type WorkStep,
  withWork,
} from "./thread.ts";

// ULIDs whose time part is a known wall-clock ms.
const ulidAt = (ms: number, tail = "0000000000000000") => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let rest = ms, i = 0; i < 10; i++, rest = Math.floor(rest / 32))
    time = alphabet[rest % 32] + time;
  return time + tail;
};
const message = (
  id: string,
  seq: number,
  role: "user" | "assistant" = "user",
  extra: Partial<AgentMessage> = {},
): AgentMessage => ({ id, seq, at: seq * 1_000_000, role, text: id, final: true, ...extra });
const step = (key: string, startT: number): WorkStep => ({
  key,
  testId: "step-row",
  title: key,
  meta: "",
  time: "",
  state: "done",
  stateLabel: "Done",
  startT,
  endT: startT + 500,
});

describe("the conversation's order", () => {
  it("interleaves messages, questions with their answers, and results as the task produced them", () => {
    const question: AgentQuestion = {
      askId: "ask",
      seq: 4,
      question: "Which format?",
      options: [],
      allowText: true,
      answer: { askId: "ask", text: "PDF", by: "user" },
    };
    const result: AgentResult = { id: "result", seq: 9, summary: "Done", files: [] };
    const items = threadItems(
      [message("task", 1), message("plan", 2, "assistant"), message("reply", 8, "assistant")],
      [question],
      [result],
    );
    expect(items.map((item) => item.key)).toEqual([
      "message-task",
      "message-plan",
      "question-ask",
      "answer-ask",
      "message-reply",
      "result-result",
    ]);
    expect(items.map((item) => item.speaker)).toEqual(["user", "dot", "dot", "user", "dot", "dot"]);
  });

  it("shows no reply bubble when the question timed out or the task stopped", () => {
    const question: AgentQuestion = {
      askId: "ask",
      seq: 1,
      question: "Which format?",
      options: [],
      allowText: true,
      answer: { askId: "ask", by: "timeout" },
    };
    expect(threadItems([], [question]).map((item) => item.kind)).toEqual(["question"]);
  });

  it("marks where the computer changed hands, and only a hand-back the user made", () => {
    const took = ulidAt(1_000);
    const items = threadItems(
      [message("Download it", 1), message("It needs your password.", 2, "assistant")],
      [],
      [],
      [
        {
          requestId: took,
          reason: "other",
          note: "",
          by: "user",
          seq: 3,
          time: 1_000,
          end: { requestId: took, by: "user" },
          endSeq: 5,
          endTime: 2_000,
        },
        {
          requestId: ulidAt(3_000),
          reason: "login",
          note: "Sign in",
          seq: 6,
          time: 3_000,
          taken: { seq: 7, time: 3_500 },
          end: { requestId: ulidAt(3_000), by: "stop" },
          endSeq: 8,
        },
        { requestId: ulidAt(4_000), reason: "login", note: "Sign in again", seq: 9, time: 4_000 },
      ],
    );
    expect(
      items.map((item) => (item.kind === "control" ? `${item.took}@${item.at}` : item.key)),
    ).toEqual([
      "message-Download it",
      "message-It needs your password.",
      "true@1000",
      "false@2000",
      "true@3500",
    ]);
    expect(threadRows(items).every((row) => row.item.kind !== "control" || !row.separator)).toBe(
      true,
    );
  });

  it("says dot handed the computer over, and a Not now the user said to it", () => {
    const handed = ulidAt(1_000);
    const items = threadItems(
      [],
      [],
      [],
      [
        {
          requestId: handed,
          reason: "login",
          note: "Sign in",
          seq: 1,
          time: 1_000,
          taken: { seq: 2, time: 1_100 },
          end: { requestId: handed, by: "user", declined: true },
          endSeq: 3,
          endTime: 2_000,
        },
      ],
    );
    expect(items.flatMap((item) => (item.kind === "control" ? [controlLine(item)] : []))).toEqual([
      "dot handed you the computer",
      "You said not now",
    ]);
  });
});

describe("the work line of each turn", () => {
  it("gives each task or follow-up its steps, and keeps a steer in the turn it changed", () => {
    const items = threadItems([
      message("task", 1),
      message("steer", 5, "user", { kind: "steer" }),
      message("followup", 10, "user", { kind: "followup" }),
    ]);
    const thread = withWork(items, [step("a", 2000), step("b", 6000), step("c", 11000)], false);
    expect(thread.map((item) => item.key)).toEqual([
      "message-task",
      "message-steer",
      "work-message-task",
      "message-followup",
      "work-message-followup",
    ]);
    const work = thread.filter((item) => item.kind === "work");
    expect(work.map((item) => item.steps.map((s) => s.key))).toEqual([["a", "b"], ["c"]]);
    expect(work.map((item) => item.startMs)).toEqual([1000, 10_000]);
  });

  it("files a follow-up dot received after the task it waited for, as a turn of its own", () => {
    // Queued at 4, while dot worked; delivered at 10, once the task was done.
    const items = threadItems([
      message("task", 1),
      message("working", 3, "assistant"),
      message("followup", 10, "user", { kind: "followup", delivery: "sent" }),
      message("done", 8, "assistant"),
      message("next", 12, "assistant"),
    ]);
    const thread = withWork(items, [step("a", 1500), step("b", 4000), step("c", 11_000)], false);
    expect(thread.map((item) => item.key)).toEqual([
      "message-task",
      "message-working",
      "message-done",
      "work-message-task",
      "message-followup",
      "message-next",
      "work-message-followup",
    ]);
    const work = thread.filter((item) => item.kind === "work");
    expect(work.map((item) => item.steps.map((s) => s.key))).toEqual([["a", "b"], ["c"]]);
  });

  it("starts no turn at a queued message, nor at one taken back to edit or cancelled", () => {
    const messages = [
      message("task", 1),
      message("working", 3, "assistant"),
      message("queued", 4, "user", { kind: "followup", queued: true }),
      message("withdrawn", 5, "user", { kind: "followup", delivery: "withdrawn" }),
      message("cancelled", 6, "user", { kind: "followup", delivery: "cancelled" }),
      message("still", 8, "assistant"),
    ];
    const items = threadItems(messages);
    expect(items.map((item) => item.key)).toEqual([
      "message-task",
      "message-working",
      "message-queued",
      "message-still",
    ]);
    const steps = [step("a", 2000), step("b", 7000)];
    const lines = (thread: ThreadItem[]) =>
      thread.flatMap((item) =>
        item.kind === "work" ? [[item.startMs, item.steps.map((s) => s.key)]] : [],
      );
    expect(lines(withWork(items, steps, true))).toEqual([[1000, ["a", "b"]]]);
    // Handed the unsent ones as well, the live line still counts the task from its start.
    const unsent = messages.slice(3, 5).map(
      (sent): ThreadItem => ({
        kind: "message",
        key: `message-${sent.id}`,
        speaker: "user",
        message: sent,
      }),
    );
    expect(lines(withWork([...items, ...unsent], steps, true))).toEqual([[1000, ["a", "b"]]]);
  });

  it("keeps a message Stop left unsent after the turn's line, and starts no turn for it", () => {
    const items = threadItems([
      message("task", 1),
      message("working", 3, "assistant"),
      message("cancelled", 4, "user", { kind: "followup", delivery: "cancelled" }),
      message("unsent", 9, "user", { kind: "followup", delivery: "cancelled", stopped: true }),
    ]);
    expect(
      withWork(items, [step("a", 2000), step("b", 5000)], false).map((item) => item.key),
    ).toEqual(["message-task", "message-working", "work-message-task", "message-unsent"]);
  });

  it("says what each turn's model calls cost on its line, an estimate if any call was", () => {
    const items = threadItems([
      message("task", 1),
      message("followup", 10, "user", { kind: "followup" }),
    ]);
    const call = (atMs: number, usd: number, estimated = false) => ({
      atMs,
      route: "openrouter",
      model: "glm-5.3",
      usd,
      estimated,
    });
    const thread = withWork(items, [step("a", 2000), step("c", 11000)], false, [
      call(2500, 0.1),
      call(3000, 0.05, true),
      call(12_000, 0.02),
      call(13_000, 0),
    ]);
    const [first, second] = thread.flatMap((item) => (item.kind === "work" ? [item.spend] : []));
    expect(first?.usd).toBeCloseTo(0.15);
    expect(first?.estimated).toBe(true);
    expect(second).toEqual({ usd: 0.02, estimated: false });
    const free = withWork(items, [step("a", 2000)], false, [call(2500, 0)]);
    expect(free.find((item) => item.kind === "work")?.spend).toBeUndefined();
  });

  it("keeps the line with dot's part of the turn, before the computer changes hands", () => {
    const taken = ulidAt(5_000);
    const items = threadItems(
      [message("Download it", 1)],
      [],
      [],
      [{ requestId: taken, reason: "other", note: "", by: "user", seq: 2, time: 5_000 }],
    );
    expect(withWork(items, [step("Open", 1_500)], true).map((item) => item.kind)).toEqual([
      "message",
      "work",
      "control",
    ]);
  });

  it("holds a live line on the latest turn before any step, and none on a turn that only talked", () => {
    const items = threadItems([message("hi", 1), message("hello", 2, "assistant")]);
    expect(withWork(items, [], false).map((item) => item.kind)).toEqual(["message", "message"]);
    expect(withWork(items, [], true).map((item) => item.kind)).toEqual([
      "message",
      "message",
      "work",
    ]);
  });
});

describe("the meta line of each finished turn", () => {
  const used = (atMs: number, extra: Partial<UsageCall> = {}): UsageCall => ({
    atMs,
    role: "main",
    route: "anthropic",
    model: "claude-sonnet-5-5",
    inputTokens: 1000,
    outputTokens: 200,
    ...extra,
  });
  const spent = (atMs: number, usd: number, estimated = false) => ({
    atMs,
    route: "anthropic",
    model: "claude-sonnet-5-5",
    usd,
    estimated,
  });
  const meta = (thread: ThreadItem[]) => thread.filter((item) => item.kind === "meta");

  it("ends a turn that only talked with its model, how long it took, its tokens and what was billed", () => {
    const items = threadItems([
      message("hi", 1),
      message("hello", 2, "assistant", { doneAt: 4_500_000 }),
    ]);
    const thread = withWork(items, [], false, [spent(3000, 0.01), spent(4000, 0.02)], {
      usage: [used(3000), used(4000, { reasoningTokens: 50 })],
    });
    expect(thread.map((item) => item.kind)).toEqual(["message", "message", "meta"]);
    expect(meta(thread)[0]).toMatchObject({
      models: [
        {
          route: "anthropic",
          model: "claude-sonnet-5-5",
          calls: 2,
          inputTokens: 2000,
          outputTokens: 400,
          reasoningTokens: 50,
        },
      ],
      durationMs: 3500,
      usd: 0.03,
      work: false,
    });
  });

  it("retains approximate cost for turn metadata", () => {
    const items = threadItems([message("hi", 1), message("hello", 2, "assistant")]);
    const thread = withWork(items, [], false, [spent(3000, 0.01), spent(3500, 0.02, true)], {
      usage: [used(3000)],
    });
    expect(meta(thread)[0]).toMatchObject({ usd: 0.03, estimated: true });
  });

  it("follows a turn's work line, leads with the main model and keeps each turn's own calls", () => {
    const items = threadItems([
      message("task", 1),
      message("done", 3, "assistant"),
      message("followup", 10, "user", { kind: "followup" }),
      message("again", 11, "assistant"),
    ]);
    const thread = withWork(items, [step("a", 2000)], false, [], {
      usage: [
        used(2100, { role: "fast", route: "openai", model: "gpt-6-luna" }),
        used(2200),
        used(10_500, { model: "claude-opus-5-5" }),
      ],
    });
    expect(thread.map((item) => item.key)).toEqual([
      "message-task",
      "message-done",
      "work-message-task",
      "meta-message-task",
      "message-followup",
      "message-again",
      "meta-message-followup",
    ]);
    const [first, second] = meta(thread);
    expect(first).toMatchObject({ work: true });
    expect(first?.kind === "meta" && first.models.map((row) => row.model)).toEqual([
      "claude-sonnet-5-5",
      "gpt-6-luna",
    ]);
    expect(second?.kind === "meta" && second.models.map((row) => row.model)).toEqual([
      "claude-opus-5-5",
    ]);
  });

  it("waits for the latest turn to finish", () => {
    const items = threadItems([message("hi", 1), message("hello", 2, "assistant")]);
    const live = withWork(items, [], true, [], { usage: [used(3000)] });
    expect(meta(live)).toEqual([]);
  });

  it("names the task's model when the calls said nothing, and has no line without a model or a reply", () => {
    const items = threadItems([message("hi", 1), message("hello", 2, "assistant")]);
    const main = { route: "claude-code", model: "sonnet" };
    expect(meta(withWork(items, [], false, [], { main }))[0]).toMatchObject({
      models: [],
      main,
    });
    expect(meta(withWork(items, [], false))).toEqual([]);
    expect(meta(withWork(threadItems([message("hi", 1)]), [], false, [], { main }))).toEqual([]);
  });

  it("counts no tokens for a turn older than the calls a full list still holds", () => {
    const items = threadItems([
      message("old", 1),
      message("reply", 2, "assistant"),
      message("new", 10, "user", { kind: "followup" }),
      message("reply2", 11, "assistant"),
    ]);
    const usage = Array.from({ length: AGENT_LIMITS.usageCalls }, (_, n) => used(9000 + n));
    const lines = meta(withWork(items, [], false, [], { usage }));
    expect(lines.map((item) => item.key)).toEqual(["meta-message-new"]);
  });
});

describe("rows and quiet times", () => {
  it("starts a group at each change of speaker, and again after a time stamp", () => {
    const start = Date.UTC(2026, 9, 8, 9, 0);
    const items = threadItems([
      { ...message(ulidAt(start), 1), text: "one" },
      { ...message(ulidAt(start + 60_000), 2, "assistant"), text: "two" },
      { ...message(ulidAt(start + 120_000), 3, "assistant"), text: "three" },
      { ...message(ulidAt(start + 20 * 60_000), 4, "assistant"), text: "four" },
    ]);
    const rows = threadRows(items, start + 21 * 60_000);
    expect(rows.map((row) => row.groupStart)).toEqual([true, true, false, true]);
    expect(rows.map((row) => row.separator !== null)).toEqual([true, false, false, true]);
    expect(rows[0]?.separator).toBe(timeLabel(start, start));
  });

  it("times a queued message by when dot received it", () => {
    const start = Date.UTC(2026, 9, 8, 9, 0);
    const items = threadItems([
      message(ulidAt(start), 1),
      message(ulidAt(start + 60_000), 3, "assistant"),
      message(ulidAt(start + 30_000), 9, "user", {
        kind: "followup",
        delivery: "sent",
        time: start + 25 * 60_000,
      }),
      message(ulidAt(start + 26 * 60_000), 10, "assistant"),
    ]);
    const rows = threadRows(items, start + 30 * 60_000);
    expect(rows.map((row) => row.separator)).toEqual([
      timeLabel(start, start),
      null,
      timeLabel(start + 25 * 60_000, start),
      null,
    ]);
  });

  it("names the day for an older time", () => {
    const now = Date.UTC(2026, 9, 8, 12);
    expect(timeLabel(now - 60_000, now)).not.toMatch(/,/);
    expect(timeLabel(now - 30 * 86_400_000, now)).toMatch(/,/);
  });
});

describe("routines in the thread", () => {
  const proposal = {
    id: ulidAt(5000),
    seq: 3,
    routineId: ulidAt(5000, "1111111111111111"),
    revision: 1,
    name: "Inbox sweep",
    summary: "Every day at 07:45 · London time",
    instruction: "Check my inbox",
    profile: "ask_first",
    notify: "changes",
    budgetUSD: null,
    approvalWindowMinutes: 60,
    missedPolicy: "run_once",
  } as const;
  it("places a proposal where dot made it and the routine's line first", () => {
    const origin = {
      kind: "routine",
      routineId: proposal.routineId,
      runId: ulidAt(1000),
      name: "Morning bills",
      dueAt: "2026-10-12T07:30:00.000Z",
    } as const;
    const items = threadItems(
      [message("a", 1), message("b", 5, "assistant")],
      [],
      [],
      [],
      [proposal],
      origin,
    );
    expect(items.map((item) => item.kind)).toEqual(["origin", "message", "routine", "message"]);
  });
});
