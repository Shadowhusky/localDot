import type { CodexTurnEpoch } from "@localdot/codex-harness";
import { parseEvent, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Redactor, redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { CodexEventMapper, type CodexEventMapperOptions } from "./events.ts";

const mappers: CodexEventMapper[] = [],
  sessions: AgentSession[] = [];
afterEach(() => {
  for (const m of mappers.splice(0)) m.close();
  for (const s of sessions.splice(0)) s.abort.abort();
  vi.useRealTimers();
});
const SECRET = "ld_web_0123456789abcdefghijkl_abcdef";
function fixture(
  options: Partial<Pick<CodexEventMapperOptions, "flushMs" | "redact" | "onFailure">> = {},
) {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const session = new AgentSession(ulid(), "fixture", "fixture", {
    append: (_id, event) => {
      parseEvent({ v: 1, id: ulid(), seq: events.length, t: 0, ...event });
      events.push({ type: event.type, data: event.data } as never);
      return event as never;
    },
  });
  sessions.push(session);
  const generation = session.beginBrain(),
    epochAbort = new AbortController(),
    auth = new AbortController(),
    stop = new AbortController();
  const epoch: CodexTurnEpoch = Object.freeze({
    id: 1,
    signal: epochAbort.signal,
    basisFrameId: ulid(),
  });
  let activeEpoch: CodexTurnEpoch | undefined = epoch,
    authGeneration = 1,
    mainThread: string | undefined = "t-main";
  const mapper = new CodexEventMapper({
    session,
    generation,
    turn: epoch,
    isTurnCurrent: (e) => e === activeEpoch,
    authGeneration: 1,
    currentAuthGeneration: () => authGeneration,
    authSignal: auth.signal,
    signal: stop.signal,
    model: "gpt-6-astra",
    mainThreadId: () => mainThread,
    redact: redactor([SECRET, "fake-auth-secret", "/private/tmp/private-capability/m.sock"]),
    flushMs: 0,
    ...options,
  });
  mappers.push(mapper);
  const start = () =>
    mapper.handle("turn/started", { threadId: "t-main", turn: { id: "u1", status: "inProgress" } });
  const delta = (text: string, itemId = "m1", method = "item/agentMessage/delta") =>
    mapper.handle(method, { threadId: "t-main", turnId: "u1", itemId, delta: text });
  const item = (type: string, fields: object = {}, completed = false) =>
    mapper.handle(completed ? "item/completed" : "item/started", {
      threadId: "t-main",
      turnId: "u1",
      item: { id: "m1", type, ...fields },
    });
  return {
    events,
    session,
    generation,
    epoch,
    epochAbort,
    auth,
    stop,
    mapper,
    start,
    delta,
    item,
    setAuth: (n: number) => {
      authGeneration = n;
    },
    replaceEpoch: () => {
      activeEpoch = Object.freeze({ ...epoch });
    },
    unsetThread: () => {
      mainThread = undefined;
    },
  };
}
function final(f: ReturnType<typeof fixture>, text = "Hello") {
  return f.item("agentMessage", { phase: "final_answer", text }, true);
}
const limits = {
  rateLimits: {
    planType: "plus",
    primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1790900000 },
  },
};

describe("Codex events under the shared session authority", () => {
  it("maps a turn start and sanitized completion without rebinding its frame", () => {
    const f = fixture();
    expect(f.start()).toEqual([{ kind: "turn_started", turnId: "u1" }]);
    expect(f.events).toEqual([{ type: "agent.state", data: { state: "thinking" } }]);
    const signal = f.mapper.handle("turn/completed", {
      threadId: "t-main",
      turn: {
        id: "u1",
        status: "failed",
        error: {
          message: "fake-auth-secret /private/tmp/private-capability/m.sock",
          codexErrorInfo: "unauthorized",
        },
      },
    });
    expect(signal).toMatchObject([
      {
        kind: "turn_completed",
        turn: {
          id: "u1",
          status: "failed",
          error: { message: "Sign in to ChatGPT again.", codexErrorInfo: "unauthorized" },
        },
      },
    ]);
    expect(JSON.stringify(signal)).not.toContain("fake-auth-secret");
    expect(f.session.lastFrameId).toBeUndefined();
    f.delta("too late");
    expect(f.events).toHaveLength(1);
  });
  it("streams and completes one final message under one stable ULID", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    f.item("agentMessage", { phase: "final_answer", text: "" });
    f.delta("Hel");
    f.delta("lo");
    final(f);
    const deltas = f.events.filter((e) => e.type === "message.delta");
    expect(deltas.map((e) => e.data.text).join("")).toBe("Hello");
    const completed = f.events.at(-1);
    expect(completed).toMatchObject({ type: "message.assistant", data: { text: "Hello" } });
    expect(new Set(f.events.map((e) => e.data.messageId)).size).toBe(1);
    expect(f.mapper.lastAssistantText()).toBe("Hello");
  });
  it("batches safe deltas every100ms and flushes an item's tail before its completion", () => {
    vi.useFakeTimers();
    const f = fixture({ flushMs: 100 });
    f.start();
    f.events.length = 0;
    f.delta("A".repeat(50));
    f.delta("B".repeat(50));
    expect(f.events).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(f.events.filter((e) => e.type === "message.delta")).toHaveLength(1);
    final(f, "A".repeat(50) + "B".repeat(50));
    expect(
      f.events
        .filter((e) => e.type === "message.delta")
        .map((e) => e.data.text)
        .join(""),
    ).toBe("A".repeat(50) + "B".repeat(50));
    expect(f.events.at(-1)?.type).toBe("message.assistant");
  });
  it("treats commentary and reasoning summaries as thoughts", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    f.item("agentMessage", { phase: "commentary", text: "" });
    f.delta("checking");
    f.delta("plan", "r1", "item/reasoning/summaryTextDelta");
    f.mapper.flush();
    expect(f.events.map((e) => e.type)).toEqual(["thought.delta", "thought.delta"]);
    expect(f.events.map((e) => e.data.text).join(" ")).toBe("checking plan");
  });
  it("redacts secrets split across timed delta batches and completed text", () => {
    vi.useFakeTimers();
    const f = fixture({ flushMs: 100 });
    f.start();
    f.events.length = 0;
    f.delta(SECRET.slice(0, 18));
    vi.advanceTimersByTime(100);
    f.delta(SECRET.slice(18));
    vi.advanceTimersByTime(100);
    final(f, SECRET);
    expect(
      f.events
        .filter((e) => e.type === "message.delta")
        .map((e) => e.data.text)
        .join(""),
    ).toBe("[redacted]");
    expect(f.events.at(-1)?.data.text).toBe("[redacted]");
    expect(JSON.stringify(f.events)).not.toContain(SECRET.slice(0, 18));
  });
  it("preserves text order across items and cuts final Unicode text to the event bound", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    f.delta("first", "m1");
    f.delta("second", "m2");
    f.item("agentMessage", { text: "😀".repeat(20000) }, true);
    f.mapper.flush();
    expect(
      f.events
        .filter((e) => e.type === "message.delta")
        .map((e) => e.data.text)
        .join(""),
    ).toBe("firstsecond");
    const text = f.events.find((e) => e.type === "message.assistant")?.data.text as string;
    expect(text).toBeDefined();
    expect(text.length).toBeLessThanOrEqual(20000);
    expect(text).not.toMatch(/[\uD800-\uDBFF]…$/u);
  });
  it("splits long delta events into valid4000-character pieces without breaking Unicode", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    f.delta("😀".repeat(5000));
    final(f, "done");
    const texts = f.events
      .filter((e) => e.type === "message.delta")
      .map((e) => e.data.text as string);
    expect(texts.join("")).toBe("😀".repeat(5000));
    expect(texts.every((text) => text.length <= 4000)).toBe(true);
    expect(texts.every((text) => !/[\uD800-\uDBFF]$/u.test(text))).toBe(true);
  });
  it("switches localdot MCP states only for the active turn", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    expect(
      f.item("mcpToolCall", { server: "localdot", tool: "computer", status: "inProgress" }),
    ).toEqual([]);
    f.item("mcpToolCall", { server: "localdot", tool: "computer", status: "completed" }, true);
    expect(f.events.map((e) => e.data.state)).toEqual(["acting", "thinking"]);
  });
  it.each([
    [
      "mcpToolCall",
      { server: "localdot-x", tool: "computer", status: "inProgress" },
      "foreign_tool",
    ],
    [
      "commandExecution",
      { command: "fake-auth-secret /private/tmp/private-capability/m.sock" },
      "command",
    ],
    ["collabAgentToolCall", {}, "sub_agent"],
    ["subAgentActivity", {}, "sub_agent"],
    ["webSearch", {}, "builtin_tool"],
    ["imageGeneration", {}, "builtin_tool"],
    ["imageView", {}, "builtin_tool"],
    ["dynamicToolCall", {}, "builtin_tool"],
  ] as const)("fences unsupported %s without echoing its payload", (type, fields, what) => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    const signals = f.item(type, fields);
    expect(signals).toMatchObject([{ kind: "violation", what }]);
    expect(JSON.stringify(signals)).not.toContain("fake-auth-secret");
    f.delta("late");
    f.mapper.flush();
    expect(f.events).toEqual([]);
  });
  it("reports only applied file changes and ignores declined ones", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    expect(f.item("fileChange", { status: "declined" }, true)).toEqual([]);
    expect(
      f.item("fileChange", { status: "completed", changes: ["fake-auth-secret"] }, true),
    ).toMatchObject([{ kind: "violation", what: "file_applied" }]);
    expect(f.events).toEqual([]);
  });
  it("reports a foreign thread once and never publishes its events", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    const p = { threadId: "t-child", turnId: "u1", itemId: "m1", delta: "private" };
    expect(f.mapper.handle("item/agentMessage/delta", p)).toMatchObject([
      { kind: "violation", what: "sub_agent" },
    ]);
    expect(f.mapper.handle("item/agentMessage/delta", p)).toEqual([]);
    expect(f.events).toEqual([]);
  });
  it("ignores pre-thread, pre-turn, wrong-turn and malformed notifications", () => {
    const f = fixture();
    f.delta("early");
    expect(f.events).toEqual([]);
    f.unsetThread();
    expect(f.start()).toEqual([]);
    const g = fixture();
    g.start();
    g.events.length = 0;
    for (const [method, params] of [
      ["item/started", {}],
      ["turn/completed", { threadId: "t-main", turn: { id: "u1", status: "odd" } }],
      [
        "item/agentMessage/delta",
        { threadId: "t-main", turnId: "old", itemId: "m1", delta: "late" },
      ],
      ["x/y", null],
    ] as const)
      expect(g.mapper.handle(method, params)).toEqual([]);
    g.mapper.flush();
    expect(g.events).toEqual([]);
  });
  it("records model token usage separately from measured subscription windows", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    f.mapper.handle("thread/tokenUsage/updated", {
      threadId: "t-main",
      turnId: "u1",
      tokenUsage: { last: { inputTokens: 18813, outputTokens: 40, reasoningOutputTokens: 12 } },
    });
    const first = f.mapper.handle("account/rateLimits/updated", limits),
      second = f.mapper.handle("account/rateLimits/updated", structuredClone(limits));
    expect(first).toEqual(second);
    expect(first).toMatchObject([{ kind: "usage", data: { windows: [{ usedPercent: 7 }] } }]);
    expect(f.events.map((e) => e.type)).toEqual(["model.usage", "subscription.usage"]);
    expect(f.events[0]?.data).toEqual({
      role: "main",
      route: "chatgpt",
      model: "gpt-6-astra",
      inputTokens: 18813,
      outputTokens: 40,
      reasoningTokens: 12,
    });
    expect(JSON.stringify(f.events)).not.toMatch(/usd|cost|budget/i);
    f.mapper.handle("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 8 } } });
    expect(f.events).toHaveLength(3);
  });
  it("counts retries within its one turn and logs fixed safe error text", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    const error = {
      threadId: "t-main",
      turnId: "u1",
      willRetry: true,
      error: { message: "fake-auth-secret /private/tmp/private-capability/m.sock" },
    };
    f.mapper.handle("error", error);
    f.mapper.handle("error", error);
    f.mapper.handle("error", { ...error, willRetry: false });
    expect(f.events.map((e) => e.data.attempt)).toEqual([1, 2]);
    expect(JSON.stringify(f.events)).not.toContain("fake-auth-secret");
    expect(f.events.every((e) => e.data.message === "The ChatGPT connection is retrying.")).toBe(
      true,
    );
  });
  it.each([
    "close",
    "stop",
    "generation",
    "replacement",
    "epoch",
    "epoch-identity",
    "auth-signal",
    "auth-value",
    "takeover",
  ])("drops delayed text, state and usage after %s", async (reason) => {
    vi.useFakeTimers();
    const f = fixture({ flushMs: 100 });
    f.start();
    f.events.length = 0;
    f.delta("queued".repeat(20));
    switch (reason) {
      case "close":
        f.mapper.close();
        break;
      case "stop":
        f.stop.abort();
        break;
      case "generation":
        f.session.retireBrain(f.generation);
        break;
      case "replacement":
        f.session.beginBrain();
        break;
      case "epoch":
        f.epochAbort.abort();
        break;
      case "epoch-identity":
        f.replaceEpoch();
        break;
      case "auth-signal":
        f.auth.abort();
        break;
      case "auth-value":
        f.setAuth(2);
        break;
      case "takeover":
        void f.session.takeover("fixture", "fixture").catch(() => {});
        await Promise.resolve();
        f.events.length = 0;
        break;
    }
    vi.advanceTimersByTime(100);
    final(f, "late");
    f.item("mcpToolCall", { server: "localdot", tool: "computer", status: "inProgress" });
    expect(f.mapper.handle("account/rateLimits/updated", limits)).toEqual([]);
    expect(f.events).toEqual([]);
    expect(f.mapper.lastAssistantText()).toBeUndefined();
  });
  it("checks current authority after redaction and between appended effects", () => {
    let retire = () => {};
    const redact: Redactor = (text) => {
      retire();
      return text;
    };
    const f = fixture({ redact });
    f.start();
    f.events.length = 0;
    retire = () => f.session.retireBrain(f.generation);
    final(f);
    expect(f.events).toEqual([]);
    expect(f.mapper.lastAssistantText()).toBeUndefined();
  });
  it("consumes notification redaction failures and cancels its pending timer", () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const redact: Redactor = () => {
      throw new Error("fake-auth-secret");
    };
    const f = fixture({ redact, flushMs: 100, onFailure: failed });
    f.start();
    f.events.length = 0;
    f.delta("queued");
    expect(() => final(f)).not.toThrow();
    expect(failed).toHaveBeenCalledOnce();
    expect(f.events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("emits each final message once and refuses its late deltas", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    f.delta("Hello");
    final(f);
    final(f);
    f.delta(" late");
    f.mapper.flush();
    expect(f.events.filter((e) => e.type === "message.assistant")).toHaveLength(1);
    expect(
      f.events
        .filter((e) => e.type === "message.delta")
        .map((e) => e.data.text)
        .join(""),
    ).toBe("Hello");
  });
  it("close immediately cancels the timer and discards its unsent text", () => {
    vi.useFakeTimers();
    const f = fixture({ flushMs: 100 });
    f.start();
    f.events.length = 0;
    f.delta("queued".repeat(20));
    expect(vi.getTimerCount()).toBe(1);
    f.mapper.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(f.events).toEqual([]);
  });
  it("honors the shared generation check even when its signal has not aborted", () => {
    const f = fixture();
    f.start();
    f.events.length = 0;
    vi.spyOn(f.session, "isCurrent").mockReturnValue(false);
    final(f);
    expect(f.mapper.handle("account/rateLimits/updated", limits)).toEqual([]);
    expect(f.events).toEqual([]);
  });
});
