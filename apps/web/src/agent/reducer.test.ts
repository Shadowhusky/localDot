import { LocalDotEvent, ulidTime } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyAgentModel, AGENT_LIMITS as L } from "./model.ts";
import { createAgentFeed, parseAgentEvent, projectAgentEvent } from "./reducer.ts";

const id = (n: number) => String(n).padStart(26, "0");
const ev = (seq: number, type: string, data: unknown, step?: string) =>
  LocalDotEvent.parse({
    v: 1,
    id: id(seq),
    seq,
    t: seq * 1000,
    agent: "main",
    type,
    data,
    ...(step ? { step } : {}),
  });
const reduce = (events: LocalDotEvent[]) => events.reduce(projectAgentEvent, emptyAgentModel());
const message = id(10000),
  other = id(10001),
  ask = id(20000),
  takeover = id(20001);
describe("bounded agent projection", () => {
  it("holds the Unlock card up from saved keys meeting a lock until they open again", () => {
    const locked = reduce([ev(0, "keys.lock", { locked: true })]);
    expect(locked.keysLocked).toBe(true);
    expect(projectAgentEvent(locked, ev(1, "keys.lock", { locked: false })).keysLocked).toBe(false);
    expect(emptyAgentModel().keysLocked).toBe(false);
  });
  it("correlates interleaved messages by ID; finals replace deltas and ignore later deltas/replay", () => {
    const events = [
      ev(0, "message.delta", { messageId: message, text: "pre" }),
      ev(1, "message.delta", { messageId: other, text: "other" }),
      ev(2, "message.delta", { messageId: message, text: "fix" }),
      ev(3, "message.assistant", { messageId: message, text: "authoritative" }),
      ev(4, "message.delta", { messageId: message, text: "stale" }),
    ];
    const model = reduce(events);
    expect([...model.messages.values()].map((m) => [m.id, m.text, m.final])).toEqual([
      [message, "authoritative", true],
      [other, "other", false],
    ]);
    expect(events.reduce(projectAgentEvent, model)).toBe(model);
    expect(events[0]?.data).toEqual({ messageId: message, text: "pre" });
  });
  it("keeps when the computer changed hands, in session time, to place it among the steps", () => {
    const model = reduce([
      ev(1, "takeover.request", { requestId: takeover, reason: "login", note: "Sign in" }),
      ev(2, "control.change", { holder: "user", reason: "handoff_request" }),
      ev(3, "takeover.end", { requestId: takeover, by: "user" }),
    ]);
    expect(model.takeovers.get(takeover)).toMatchObject({
      at: 1000,
      taken: { seq: 2, at: 2000 },
      endAt: 3000,
    });
  });
  it("keeps when a reply was whole and each call's tokens at its time, for the turn's line", () => {
    const usage = { role: "main", route: "anthropic", model: "claude-sonnet-5-5" };
    const model = reduce([
      ev(0, "message.delta", { messageId: message, text: "pa" }),
      ev(1, "model.usage", { ...usage, inputTokens: 10, outputTokens: 2 }),
      ev(2, "model.usage", { ...usage, inputTokens: 5, outputTokens: 1, reasoningTokens: 3 }),
      ev(3, "message.assistant", { messageId: message, text: "part" }),
    ]);
    expect(model.messages.get(message)).toMatchObject({ at: 0, doneAt: 3000, final: true });
    expect(model.usageCalls).toEqual([
      { ...usage, atMs: 1, inputTokens: 10, outputTokens: 2 },
      { ...usage, atMs: 2, inputTokens: 5, outputTokens: 1, reasoningTokens: 3 },
    ]);
    expect(model.usage[0]).toMatchObject({ inputTokens: 15, outputTokens: 3, calls: 2 });
  });
  it("keeps the line dot gave a call on the step it starts", () => {
    const model = reduce([
      ev(
        0,
        "step.start",
        { kind: "shell", intent: "Checking which paint apps are installed" },
        "one",
      ),
      ev(1, "step.start", { kind: "gui" }, "two"),
    ]);
    expect(model.steps.get("one")?.intent).toBe("Checking which paint apps are installed");
    expect(model.steps.get("two")).not.toHaveProperty("intent");
  });
  it("retains two legitimately identical user messages with their distinct IDs", () => {
    const model = reduce([
      ev(0, "message.user", { messageId: message, text: "again", kind: "task" }),
      ev(1, "message.user", { messageId: other, text: "again", kind: "followup" }),
    ]);
    expect(model.messages.size).toBe(2);
    expect(model.messages.get(message)?.role).toBe("user");
  });
  it("keeps tool output and tool vs step outcomes with the envelope step under interleaving", () => {
    const model = reduce([
      ev(0, "step.start", { kind: "shell" }, "one"),
      ev(1, "tool.start", { tool: "run", title: "First" }, "one"),
      ev(2, "tool.start", { tool: "run", title: "Second" }, "two"),
      ev(3, "tool.output", { stream: "stdout", chunk: "first" }, "one"),
      ev(4, "tool.output", { stream: "stderr", chunk: "second" }, "two"),
      ev(5, "tool.output", { stream: "stdout", chunk: "unassociated" }),
      ev(6, "tool.end", { ok: false, exitCode: 1 }, "one"),
      ev(7, "step.end", { status: "blocked", note: "review" }, "one"),
    ]);
    expect(model.steps.get("one")).toMatchObject({
      tool: { ok: false, exitCode: 1 },
      status: "blocked",
      output: [{ stream: "stdout", text: "first" }],
    });
    expect(model.steps.get("two")).toMatchObject({
      tool: { title: "Second" },
      output: [{ stream: "stderr", text: "second" }],
    });
    expect(model.steps.get("two")?.status).toBeUndefined();
  });
  it("matches pending question and takeover IDs, so an old answer cannot release newer ownership", () => {
    const model = reduce([
      ev(0, "ask.request", {
        askId: ask,
        question: "Which?",
        options: [{ key: "A", text: "One" }],
        allowText: false,
      }),
      ev(1, "ask.request", { askId: other, question: "Later?", options: [], allowText: true }),
      ev(2, "ask.answer", { askId: ask, option: "A", by: "user" }),
      ev(3, "takeover.request", { requestId: takeover, reason: "login", note: "Sign in" }),
      ev(4, "takeover.end", { requestId: ask, by: "stop" }),
    ]);
    expect(model.pendingAsk).toBe(other);
    expect(model.questions.get(ask)?.answer?.option).toBe("A");
    expect(model.pendingTakeover).toBe(takeover);
  });
  it("keeps a result and subsequent idle follow-up; only session end fences stale thinking", () => {
    const model = reduce([
      ev(0, "task.result", {
        summary: "Done",
        files: [{ name: "report.txt", path: "/untrusted/never-fetch", bytes: 12 }],
      }),
      ev(1, "agent.state", { state: "idle" }),
      ev(2, "message.user", { messageId: message, text: "Change it", kind: "followup" }),
      ev(3, "agent.state", { state: "thinking" }),
    ]);
    expect(model.ended).toBeNull();
    expect(model.results).toHaveLength(1);
    expect(model.state?.state).toBe("thinking");
    const ended = projectAgentEvent(model, ev(4, "session.end", { reason: "stopped" }));
    expect(projectAgentEvent(ended, ev(5, "agent.state", { state: "acting" }))).toBe(ended);
  });
  it("preserves blocked outcomes through tool completion and clears them when work resumes", () => {
    const result = reduce([
      ev(0, "agent.state", { state: "acting" }),
      ev(1, "task.result", { outcome: "blocked", summary: "Unfinished work.", files: [] }),
      ev(2, "agent.state", { state: "thinking" }),
    ]);
    expect(result.completion).toBe("blocked");
    expect(result.results[0]?.outcome).toBe("blocked");
    const continued = projectAgentEvent(result, ev(3, "step.start", { kind: "think" }, "next"));
    expect(continued.completion).toBeUndefined();
    expect(continued.results[0]?.outcome).toBe("blocked");
    const idle = projectAgentEvent(
      result,
      ev(3, "agent.state", { state: "idle", reason: "blocked" }),
    );
    const followup = projectAgentEvent(idle, ev(4, "agent.state", { state: "thinking" }));
    expect(followup.completion).toBeUndefined();
    expect(followup.results[0]?.outcome).toBe("blocked");
  });
  it("marks a follow-up sent while dot works as waiting for the task, and keeps that on replay", () => {
    const queued = id(10002);
    const events = [
      ev(0, "agent.state", { state: "acting" }),
      ev(1, "message.user", { messageId: message, text: "Also email it", kind: "steer" }),
      ev(2, "message.user", { messageId: queued, text: "Then tidy up", kind: "followup" }),
      ev(3, "agent.state", { state: "idle" }),
      ev(4, "message.user", { messageId: other, text: "One more", kind: "followup" }),
    ];
    const model = reduce(events);
    expect([...model.messages.values()].map((m) => [m.kind, m.queued])).toEqual([
      ["steer", undefined],
      ["followup", true],
      ["followup", undefined],
    ]);
    expect(projectAgentEvent(model, events[2] as LocalDotEvent).messages.get(queued)?.queued).toBe(
      true,
    );
  });
  it("moves a queued message to where dot received it, whether sent or steered, and on replay", () => {
    const later = id(10002),
      steered = id(10003),
      kept = id(10004);
    const queued = (seq: number, messageId: string) =>
      ev(seq, "message.user", { messageId, text: messageId, kind: "followup", queued: true });
    const events = [
      ev(0, "message.user", { messageId: message, text: "Draw a dog", kind: "task" }),
      queued(1, later),
      queued(2, steered),
      queued(3, kept),
      ev(4, "message.assistant", { messageId: other, text: "Drawing it now." }),
      ev(5, "message.delivery", { messageId: steered, state: "steering" }),
      ev(6, "message.delivery", { messageId: kept, state: "withdrawn" }),
      ev(7, "task.result", { summary: "Drew a dog.", files: [] }),
      ev(8, "message.delivery", { messageId: later, state: "sent" }),
    ];
    const model = reduce(events);
    const placed = (messageId: string) => {
      const { seq, at, time, queued, kind, delivery } = model.messages.get(messageId) ?? {};
      return { seq, at, time, queued, kind, delivery };
    };
    expect(placed(later)).toEqual({
      seq: 8,
      at: 8000,
      time: ulidTime(id(8)),
      queued: false,
      kind: "followup",
      delivery: "sent",
    });
    expect(placed(steered)).toMatchObject({
      seq: 5,
      at: 5000,
      kind: "steer",
      delivery: "steering",
    });
    expect(placed(kept)).toEqual({
      seq: 3,
      at: 3000,
      time: undefined,
      queued: false,
      kind: "followup",
      delivery: "withdrawn",
    });
    // History read again projects the same thread; the queued event replayed moves nothing back.
    expect(reduce(events).messages.get(later)).toEqual(model.messages.get(later));
    expect(projectAgentEvent(model, events[1] as LocalDotEvent)).toBe(model);
  });
  it("keeps a queued message Stop left unsent where Stop left it, unlike one the user cancelled", () => {
    const mine = id(10002),
      unsent = id(10003);
    const model = reduce([
      ev(0, "message.user", { messageId: message, text: "Draw a dog", kind: "task" }),
      ev(1, "message.user", {
        messageId: mine,
        text: "Never mind",
        kind: "followup",
        queued: true,
      }),
      ev(2, "message.user", {
        messageId: unsent,
        text: "Then a hat",
        kind: "followup",
        queued: true,
      }),
      ev(3, "message.delivery", { messageId: mine, state: "cancelled" }),
      ev(4, "message.delivery", { messageId: unsent, state: "cancelled", reason: "stopped" }),
      ev(5, "session.end", { reason: "stopped" }),
    ]);
    expect(model.messages.get(mine)).toMatchObject({ seq: 1, delivery: "cancelled" });
    expect(model.messages.get(mine)?.stopped).toBeUndefined();
    expect(model.messages.get(unsent)).toMatchObject({
      seq: 4,
      at: 4000,
      queued: false,
      delivery: "cancelled",
      stopped: true,
    });
  });
  it("marks a message Stop gave back, whether dot had it or it waited", () => {
    const [task, waiting] = [id(10004), id(10005)];
    const model = reduce([
      ev(0, "message.user", { messageId: task, text: "Draw a dog", kind: "task" }),
      ev(1, "message.user", {
        messageId: waiting,
        text: "Then a hat",
        kind: "followup",
        queued: true,
      }),
      ev(2, "message.delivery", { messageId: task, state: "withdrawn", reason: "stopped" }),
      ev(3, "message.delivery", { messageId: waiting, state: "withdrawn", reason: "stopped" }),
    ]);
    for (const id of [task, waiting])
      expect(model.messages.get(id)).toMatchObject({
        queued: false,
        delivery: "withdrawn",
        stopped: true,
      });
  });
  it("projects plans, memory changes and file patches without mutating older snapshots", () => {
    const original = reduce([
      ev(0, "plan.set", { items: [{ id: "p", text: "Review", status: "todo" }] }),
    ]);
    const next = [
      ev(1, "plan.update", { id: "p", status: "done" }),
      ev(2, "memory.change", { file: "MEMORY.md", patch: "memory", changeId: ask }),
      ev(3, "file.change", { path: "file.txt", op: "modify", patch: "diff" }),
    ].reduce(projectAgentEvent, original);
    expect(original.plan[0]?.status).toBe("todo");
    expect(next.plan[0]?.status).toBe("done");
    expect(next.changes.map((c) => [c.type, c.patch, c.changeId])).toEqual([
      ["memory", "memory", ask],
      ["file", "diff", undefined],
    ]);
  });
  it("bounds a long transcript, terminal chunks, plan and patches with visible truncation", () => {
    let model = emptyAgentModel(),
      seq = 0;
    for (let n = 0; n < 10000; n++)
      model = projectAgentEvent(
        model,
        ev(seq++, "message.assistant", { messageId: id(100000 + n), text: "message" }),
      );
    model = projectAgentEvent(
      model,
      ev(seq++, "tool.start", { tool: "run", title: "Output" }, "shell"),
    );
    for (let n = 0; n < 600; n++)
      model = projectAgentEvent(
        model,
        ev(
          seq++,
          "tool.output",
          { stream: n % 2 ? "stdout" : "stderr", chunk: "x".repeat(200) },
          "shell",
        ),
      );
    model = projectAgentEvent(
      model,
      ev(seq++, "plan.set", {
        items: Array.from({ length: 1000 }, (_, n) => ({
          id: String(n),
          text: "item",
          status: "todo",
        })),
      }),
    );
    model = projectAgentEvent(
      model,
      ev(seq++, "file.change", { path: "x", op: "create", patch: "p".repeat(40000) }),
    );
    expect(model.messages.size).toBe(L.messages);
    expect(
      model.steps.get("shell")?.output.reduce((sum, c) => sum + c.text.length, 0),
    ).toBeLessThanOrEqual(L.outputText);
    expect(model.steps.get("shell")?.output.length).toBeLessThanOrEqual(512);
    expect(model.steps.get("shell")?.outputTruncated).toBe(true);
    expect(model.plan).toHaveLength(L.plan);
    expect(model.changes[0]?.patch).toHaveLength(L.patchText);
    expect(model.changes[0]?.truncated).toBe(true);
    expect(model.historyTruncated).toBe(true);
  });
  it("holds a connection's card beside the task's own decision and clears each by its own answer", () => {
    const card = (seq: number, approvalId: string, actionClass: string, title: string) =>
      ev(seq, "approval.request", {
        approvalId,
        generation: 1,
        revision: 1,
        expiresAt: 9_000_000,
        actionClass,
        risk: actionClass === "network" ? "medium" : "high",
        title,
        kind: "permission",
        preview: { fields: [["Destination", "chat.example.com:5222"]] },
      });
    const connection = id(31000),
      approval = id(31001);
    const both = reduce([
      card(0, connection, "network", "wechat wants to connect to chat.example.com:5222"),
      card(1, approval, "send", "Send as you"),
    ]);
    expect(both.connection?.approvalId).toBe(connection);
    expect(both.approval?.approvalId).toBe(approval);
    const answered = projectAgentEvent(
      both,
      ev(2, "approval.resolve", { approvalId: connection, decision: "approve", by: "user" }),
    );
    expect(answered.connection).toBeNull();
    expect(answered.approval?.approvalId).toBe(approval);
    expect(answered.approvalOutcome).toEqual({
      approvalId: connection,
      decision: "approve",
      actionClass: "network",
    });
  });
  it("keeps the last decision's note and the Always allow choice it saved, until removed", () => {
    const approval = id(30000),
      rule = id(30001);
    const request = ev(0, "approval.request", {
      approvalId: approval,
      generation: 1,
      revision: 1,
      expiresAt: 9_000_000,
      actionClass: "send",
      risk: "high",
      title: "Send as you",
      kind: "send",
      preview: { fields: [] },
    });
    const site = {
      scope: "site",
      label: "On mail.example.test",
      site: "https://mail.example.test",
      actionClass: "send",
      id: rule,
    };
    const saved = reduce([
      request,
      ev(1, "approval.resolve", { approvalId: approval, decision: "approve", by: "user" }),
      ev(2, "rule.created", site),
    ]);
    expect(saved.approval).toBeNull();
    expect(saved.approvalOutcome).toEqual({
      approvalId: approval,
      decision: "approve",
      actionClass: "send",
      rule: site,
    });
    const other = { ...site, id: id(30002), site: "https://other.example.test" };
    expect(projectAgentEvent(saved, ev(3, "rule.removed", other)).approvalOutcome).toEqual(
      saved.approvalOutcome,
    );
    expect(projectAgentEvent(saved, ev(3, "rule.removed", site)).approvalOutcome).toEqual({
      ...saved.approvalOutcome,
      ruleRemoved: true,
    });
    const note = "Approved once. Your Always allow choice was not saved. Try again later.";
    const task = { scope: "task", label: "For this task", actionClass: "send" };
    const unsaved = reduce([
      request,
      ev(1, "approval.resolve", { approvalId: approval, decision: "approve", by: "user", note }),
      ev(2, "rule.created", task),
    ]);
    expect(unsaved.approvalOutcome).toEqual({
      approvalId: approval,
      decision: "approve",
      actionClass: "send",
      note,
    });
    const otherClass = reduce([
      request,
      ev(1, "approval.resolve", { approvalId: approval, decision: "approve", by: "user" }),
      ev(2, "rule.created", { ...task, actionClass: "post" }),
    ]);
    expect(otherClass.approvalOutcome).toEqual({
      approvalId: approval,
      decision: "approve",
      actionClass: "send",
    });
    const second = projectAgentEvent(saved, ev(3, "rule.created", task));
    expect(second.approvalOutcome?.rule).toEqual(site);
    const allowed = reduce([
      request,
      ev(1, "approval.resolve", { approvalId: approval, decision: "approve", by: "user" }),
      ev(2, "rule.created", task),
      ev(3, "rule.removed", task),
    ]);
    expect(allowed.approvalOutcome?.ruleRemoved).toBe(true);
    const kept = reduce([
      request,
      ev(1, "approval.resolve", { approvalId: approval, decision: "approve", by: "user" }),
      ev(2, "rule.created", task),
    ]);
    for (const removed of [
      { ...task, actionClass: "post" },
      { scope: "always", label: "Always", actionClass: "send" },
    ])
      expect(
        projectAgentEvent(kept, ev(3, "rule.removed", removed)).approvalOutcome?.ruleRemoved,
      ).toBeUndefined();
  });
});
describe("single event feed boundary", () => {
  it("does not notify for token deltas or duplicates, but synchronously invalidates authority events", () => {
    const feed = createAgentFeed();
    feed.reset(id(1), id(2));
    let calls = 0;
    feed.subscribe(() => calls++);
    const delta = JSON.stringify(ev(0, "message.delta", { messageId: message, text: "text" }));
    expect(feed.accept(delta)).not.toBeNull();
    expect(feed.accept(delta)).toBeNull();
    expect(calls).toBe(0);
    feed.accept(
      JSON.stringify(
        ev(1, "ask.request", { askId: ask, question: "Which?", options: [], allowText: true }),
      ),
    );
    expect(calls).toBe(1);
    expect(feed.read().model.pendingAsk).toBe(ask);
    feed.accept(
      JSON.stringify(
        ev(2, "rule.removed", { scope: "task", label: "For this task", actionClass: "send" }),
      ),
    );
    expect(calls).toBe(2);
  });
  it("reads the status again when dot starts or stops working, not as it moves between steps", () => {
    const feed = createAgentFeed();
    feed.reset(id(1), id(2));
    let calls = 0;
    feed.subscribe(() => calls++);
    const state = (seq: number, data: Record<string, string>) =>
      feed.accept(JSON.stringify(ev(seq, "agent.state", data)));
    state(0, { state: "thinking" });
    expect(calls).toBe(1);
    state(1, { state: "acting" });
    state(2, { state: "observing" });
    state(3, { state: "thinking" });
    expect(calls).toBe(1);
    expect(feed.read().model.state?.state).toBe("thinking");
    state(4, { state: "thinking", reason: "model busy" });
    state(5, { state: "waiting_user" });
    state(6, { state: "acting" });
    expect(calls).toBe(4);
  });
  it("rejects malformed, oversized or unbounded-identity events with fixed errors and no partial projection", () => {
    for (const data of [
      "not-json",
      JSON.stringify({
        ...ev(0, "agent.state", { state: "thinking" }),
        data: { state: "invented", token: "inert-do-not-echo" },
      }),
      "x".repeat(1048577),
      JSON.stringify(ev(0, "tool.output", { stream: "stdout", chunk: "text" }, "x".repeat(513))),
    ]) {
      const feed = createAgentFeed();
      feed.reset(id(1), id(2));
      const previous = feed.read().model;
      expect(feed.accept(data)).toBeNull();
      expect(feed.read().model).toBe(previous);
      expect(feed.read().streamError).toBe(
        "Activity could not be verified. Reconnect to load it again.",
      );
      expect(parseAgentEvent(data)).toBeNull();
    }
  });
  it("does not skip a replay gap, and clears the gap only after all observed seqs replay in order", () => {
    const feed = createAgentFeed();
    feed.reset(id(1), id(2));
    feed.accept(JSON.stringify(ev(0, "agent.state", { state: "thinking" })));
    expect(feed.accept(JSON.stringify(ev(2, "agent.state", { state: "acting" })))).toBeNull();
    expect(feed.read().model.state?.state).toBe("thinking");
    expect(feed.read().streamError).not.toBeNull();
    feed.accept(JSON.stringify(ev(1, "agent.state", { state: "observing" })));
    expect(feed.read().streamError).not.toBeNull();
    feed.accept(JSON.stringify(ev(2, "agent.state", { state: "acting" })));
    expect(feed.read().streamError).toBeNull();
    expect(feed.read().model.state?.state).toBe("acting");
  });
});

describe("what a task costs and whether its model is being retried", () => {
  const spend = (seq: number, costUSD: number, basis: "billed" | "estimated", extra = {}) =>
    ev(seq, "model.spend", {
      route: "openrouter",
      model: "glm-5.3",
      costUSD,
      basis,
      taskSpentUSD: seq / 100,
      daySpentUSD: 1 + seq / 100,
      ...extra,
    });
  it("keeps keyd's running totals, each call at its time, and marks the total an estimate once any part is", () => {
    const billed = reduce([spend(1, 0.01, "billed"), spend(2, 0.01, "billed")]);
    expect(billed.spend).toEqual({ taskUSD: 0.02, dayUSD: 1.02, estimated: false });
    expect(billed.spendCalls.map((call) => [call.atMs, call.usd])).toEqual([
      [1, 0.01],
      [2, 0.01],
    ]);
    const mixed = reduce([
      spend(1, 0.01, "estimated"),
      spend(2, 0.01, "billed", { taskLimitUSD: 5 }),
    ]);
    expect(mixed.spend).toEqual({ taskUSD: 0.02, dayUSD: 1.02, estimated: true, taskLimitUSD: 5 });
  });
  it("holds a retry until a later state says the model moved on", () => {
    const retry = (seq: number, waitMs: number, fallback?: string) =>
      ev(seq, "model.retry", {
        role: "main",
        attempt: 1,
        waitMs,
        status: 429,
        message: "busy",
        ...(fallback ? { fallback } : {}),
      });
    expect(reduce([retry(1, 20_000)]).retrying).toBe(true);
    expect(
      reduce([retry(1, 20_000), ev(2, "agent.state", { state: "paused", reason: "model busy" })])
        .retrying,
    ).toBe(true);
    expect(reduce([retry(1, 20_000), ev(2, "agent.state", { state: "thinking" })]).retrying).toBe(
      false,
    );
    expect(reduce([retry(1, 0, "qwen")]).retrying).toBe(false);
  });
});

describe("routines in a task", () => {
  it("keeps the task's origin and each routine dot proposed", () => {
    const origin = {
      kind: "routine",
      routineId: id(30000),
      runId: id(30001),
      name: "Morning bills",
      dueAt: "2026-10-12T07:30:00.000Z",
    } as const;
    const proposal = {
      routineId: id(30002),
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
    const model = reduce([
      ev(0, "session.start", { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", origin }),
      ev(1, "routine.proposed", proposal),
    ]);
    expect(model.origin).toEqual(origin);
    expect(model.routineProposals.get(proposal.routineId)).toMatchObject({ ...proposal, seq: 1 });
    expect(
      reduce([ev(0, "session.start", { screen: { w: 1, h: 1, scale: 1 }, os: "linux" })]),
    ).not.toHaveProperty("origin");
  });
});

it("retains image references when rebuilding historical steps and bounds their count", () => {
  const image = { name: `step-image-${id(44)}.jpg`, alt: "~/hero1.jpg" };
  const events = [
    ev(0, "step.start", { kind: "file" }, "image-read"),
    ev(1, "tool.start", { tool: "files", title: "read hero1.jpg" }, "image-read"),
    ev(2, "tool.output", { stream: "stdout", chunk: "hero1.jpg", image }, "image-read"),
    ev(3, "step.end", { status: "ok" }, "image-read"),
  ];
  const model = reduce(events.map((e) => LocalDotEvent.parse(JSON.parse(JSON.stringify(e)))));
  expect(model.steps.get("image-read")?.images).toEqual([image]);
  const repeated = projectAgentEvent(
    model,
    ev(4, "tool.output", { stream: "stdout", chunk: "", image }, "image-read"),
  );
  expect(repeated.steps.get("image-read")?.images).toHaveLength(1);
  expect(() =>
    ev(
      5,
      "tool.output",
      { stream: "stdout", chunk: "", image: { ...image, name: "../../secret.jpg" } },
      "image-read",
    ),
  ).toThrow();
  const many = Array.from({ length: 12 }, (_, i) =>
    ev(
      i + 5,
      "tool.output",
      { stream: "stdout", chunk: "", image: { ...image, name: `step-image-${id(100 + i)}.jpg` } },
      "image-read",
    ),
  ).reduce(projectAgentEvent, repeated);
  expect(many.steps.get("image-read")?.images).toHaveLength(8);
});

it("keeps one row per child, led by its latest run, with the runs before kept inside it", () => {
  const child = { id: "child-a", runId: "run-1", label: "Research" };
  const events = [
    ev(0, "subagent.state", { ...child, state: "running" }),
    ev(1, "subagent.state", { ...child, id: "child-b", runId: "run-2", state: "running" }),
    ev(2, "subagent.state", {
      ...child,
      state: "completed",
      summary: "Verified https://example.test",
    }),
    // dot wakes child-a again: the new run leads its row, which moves to the top of the list.
    ev(3, "subagent.state", { ...child, runId: "run-3", state: "running" }),
  ];
  const model = reduce(events);
  expect([...model.subagents.values()].map((c) => [c.id, c.runId, c.state])).toEqual([
    ["child-b", "run-2", "running"],
    ["child-a", "run-3", "running"],
  ]);
  expect(model.subagents.get("child-a")).toMatchObject({
    startedAt: 3000,
    earlier: [
      {
        runId: "run-1",
        state: "completed",
        summary: "Verified https://example.test",
        startedAt: 0,
        endedAt: 2000,
      },
    ],
  });
  expect(model.subagents.get("child-a")?.summary).toBeUndefined();
  // Earlier runs read newest first; one replaced while it still ran ended unheard.
  const woken = [
    ev(4, "subagent.state", { ...child, runId: "run-3", state: "completed", summary: "Again" }),
    ev(5, "subagent.state", { ...child, runId: "run-4", state: "running" }),
    ev(6, "subagent.state", { ...child, runId: "run-5", state: "running" }),
  ].reduce(projectAgentEvent, model);
  const runs = (m: typeof model) =>
    m.subagents.get("child-a")?.earlier.map((run) => [run.runId, run.state, run.summary]);
  expect(runs(woken)).toEqual([
    ["run-4", "interrupted", undefined],
    ["run-3", "completed", "Again"],
    ["run-1", "completed", "Verified https://example.test"],
  ]);
  // Its end, arriving late, lands on that run; the row still follows run-5.
  const late = projectAgentEvent(
    woken,
    ev(7, "subagent.state", { ...child, runId: "run-4", state: "completed", summary: "Late" }),
  );
  expect(late.subagents.get("child-a")).toMatchObject({ runId: "run-5", state: "running" });
  expect(runs(late)?.[0]).toEqual(["run-4", "completed", "Late"]);
  // The task's end interrupts only what still runs.
  const ended = projectAgentEvent(late, ev(8, "session.end", { reason: "error" }));
  expect([...ended.subagents.values()].map((c) => [c.id, c.state])).toEqual([
    ["child-b", "interrupted"],
    ["child-a", "interrupted"],
  ]);
  expect(runs(ended)).toEqual(runs(late));
  expect(events.reduce(projectAgentEvent, ended)).toBe(ended);
  // A child woken many times keeps its latest runs and says the rest were let go.
  const many = Array.from({ length: L.subagentRuns + 2 }, (_, i) =>
    ev(i, "subagent.state", { ...child, runId: `wake-${i}`, state: "running" }),
  ).reduce(projectAgentEvent, emptyAgentModel());
  expect(many.subagents.get("child-a")?.earlier).toHaveLength(L.subagentRuns);
  expect(many.historyTruncated).toBe(true);
});

it("keeps why a child stopped on its run, and starts its resumed run afresh", () => {
  const child = { id: "child-a", label: "Research" };
  const model = [
    ev(0, "subagent.state", { ...child, runId: "run-1", state: "running" }),
    ev(1, "subagent.state", { ...child, runId: "run-1", state: "interrupted", reason: "limit" }),
    ev(2, "subagent.state", { ...child, runId: "run-2", state: "running", resumed: true }),
    ev(3, "subagent.state", { ...child, id: "child-b", runId: "run-3", state: "running" }),
  ].reduce(projectAgentEvent, emptyAgentModel());
  expect(model.subagents.get("child-a")).toMatchObject({
    runId: "run-2",
    state: "running",
    resumed: true,
    earlier: [{ runId: "run-1", state: "interrupted", reason: "limit" }],
  });
  expect(model.subagents.get("child-a")).not.toHaveProperty("reason");
  // A stopped task stops what still ran.
  const stopped = projectAgentEvent(model, ev(4, "session.end", { reason: "stopped" }));
  expect([...stopped.subagents.values()].map((c) => [c.id, c.state, c.reason])).toEqual([
    ["child-a", "interrupted", "stopped"],
    ["child-b", "interrupted", "stopped"],
  ]);
});
