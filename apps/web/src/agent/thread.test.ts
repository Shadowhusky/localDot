import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentQuestion, AgentResult } from "./model.ts";
import { threadItems, threadRows, timeLabel, type WorkStep, withWork } from "./thread.ts";

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
  icon: "mouse-pointer-click",
  title: key,
  metric: "",
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

  it("names the day for an older time", () => {
    const now = Date.UTC(2026, 9, 8, 12);
    expect(timeLabel(now - 60_000, now)).not.toMatch(/,/);
    expect(timeLabel(now - 30 * 86_400_000, now)).toMatch(/,/);
  });
});
