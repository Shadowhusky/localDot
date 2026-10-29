import { describe, expect, it } from "vitest";
import { redactor } from "../redact.ts";
import { ClaudeCodeEventMapper } from "./events.ts";

const SECRET = "fixture-private-token-123";
function mapper() {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const said: string[] = [];
  const map = new ClaudeCodeEventMapper(
    { append: (type, data) => events.push({ type, data }), said: (text) => said.push(text) },
    redactor([SECRET]),
    "sonnet",
  );
  const stream = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    map.handle({ type: "stream_event", parent_tool_use_id: null, event, ...extra });
  return { map, events, said, stream };
}

describe("Claude Code events", () => {
  it("never shows a known secret, even split across streamed pieces", () => {
    const f = mapper();
    f.stream({ type: "content_block_start", index: 1, content_block: { type: "text" } });
    f.stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: `Token ${SECRET.slice(0, 10)}` },
    });
    f.stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: `${SECRET.slice(10)} found.` },
    });
    f.stream({ type: "content_block_stop", index: 1 });
    const shown = JSON.stringify(f.events);
    expect(shown).not.toContain(SECRET);
    expect(f.said).toEqual(["Token [redacted] found."]);
  });
  it("shows Claude's thinking as dot's thoughts, not as a reply", () => {
    const f = mapper();
    f.stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
    f.stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "The dog needs ears." },
    });
    f.stream({ type: "content_block_stop", index: 0 });
    expect(f.events).toEqual([{ type: "thought.delta", data: { text: "The dog needs ears." } }]);
    expect(f.said).toEqual([]);
  });
  it("records the speed the API says served each call", () => {
    const usage = (f: ReturnType<typeof mapper>) =>
      f.events.filter((event) => event.type === "model.usage").map((event) => event.data);
    const fast = mapper();
    fast.stream({
      type: "message_start",
      message: { model: "claude-opus-5-5", usage: { input_tokens: 10, speed: "fast" } },
    });
    fast.stream({ type: "message_delta", usage: { output_tokens: 4 } });
    expect(usage(fast)).toEqual([
      {
        role: "main",
        route: "claude-code",
        model: "claude-opus-5-5",
        inputTokens: 10,
        outputTokens: 4,
        speed: "fast",
      },
    ]);
    // A fast request served at the standard speed, during a cooldown, says so by the end.
    const fellBack = mapper();
    fellBack.stream({
      type: "message_start",
      message: { model: "claude-opus-5-5", usage: { input_tokens: 10, speed: "fast" } },
    });
    fellBack.stream({ type: "message_delta", usage: { output_tokens: 4, speed: "standard" } });
    expect(usage(fellBack)[0]).not.toHaveProperty("speed");
  });
  it("reports the messages a reply took in, and whether more turns are queued", () => {
    const f = mapper();
    expect(f.stream({ type: "ping" }, { user_message_uuid: "a" })).toEqual([
      { kind: "consumed", uuids: ["a"] },
    ]);
    expect(
      f.map.handle({
        type: "result",
        subtype: "success",
        is_error: false,
        user_message_uuids: ["b", "c"],
        queued_turn_count: 1,
      }),
    ).toEqual([
      { kind: "consumed", uuids: ["b", "c"] },
      { kind: "result", ok: true, queued: true },
    ]);
    expect(
      f.map.handle({ type: "result", subtype: "error_during_execution", is_error: true }),
    ).toEqual([{ kind: "result", ok: false, queued: false }]);
  });
  it("treats a failed sign-in as signed out", () => {
    expect(mapper().map.handle({ type: "auth_status", error: "expired" })).toEqual([
      { kind: "error", error: "authentication_failed" },
    ]);
  });
  it("keeps each plan window's own figures as they arrive", () => {
    const f = mapper();
    f.map.plan = "pro";
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.42 },
    });
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.9,
        resetsAt: 1_900_000_000_000,
      },
    });
    expect(f.events.at(-1)).toEqual({
      type: "subscription.usage",
      data: {
        provider: "claude-code",
        plan: "pro",
        windows: [
          { window: "primary", usedPercent: 90, windowMinutes: 300, resetsAt: 1_900_000_000 },
          { window: "secondary", usedPercent: 42, windowMinutes: 10_080 },
        ],
        limitReached: false,
      },
    });
    expect(f.map.limitReached).toBe(false);
  });
  it("reads utilization as a fraction that passes 1 at the limit, and says when it lifts", () => {
    const f = mapper();
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1.07,
        resetsAt: 1_900_000_000,
      },
    });
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.005 },
    });
    expect(f.events.at(-1)?.data).toEqual({
      provider: "claude-code",
      windows: [
        { window: "primary", usedPercent: 100, windowMinutes: 300, resetsAt: 1_900_000_000 },
        { window: "secondary", usedPercent: 0.5, windowMinutes: 10_080 },
      ],
      limitReached: false,
    });
    expect(f.events.at(-2)?.data).toMatchObject({
      limitReached: true,
      limitResetsAt: 1_900_000_000,
    });
  });
  it("never shows a model's own weekly limit as the weekly limit", () => {
    const f = mapper();
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.3 },
    });
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "seven_day_opus",
        utilization: 1,
        resetsAt: 1_900_000_000,
      },
    });
    expect(f.events.at(-1)?.data).toEqual({
      provider: "claude-code",
      windows: [{ window: "secondary", usedPercent: 30, windowMinutes: 10_080 }],
      limitReached: true,
      limitResetsAt: 1_900_000_000,
    });
  });
  it("ignores a negative or missing utilization rather than inventing a figure", () => {
    const f = mapper();
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: -0.2 },
    });
    f.map.handle({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day" },
    });
    expect(f.events.map((event) => event.data)).toEqual([
      { provider: "claude-code", windows: [], limitReached: false },
    ]);
  });
  it("tells the driver about any tool that is not localDot's", () => {
    const f = mapper();
    expect(
      f.map.handle({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "server_tool_use", name: "web_search" }] },
      }),
    ).toEqual([{ kind: "violation", what: "foreign_tool" }]);
    expect(f.map.handle({ type: "user", parent_tool_use_id: "toolu_9" })).toEqual([
      { kind: "violation", what: "sub_agent" },
    ]);
    expect(
      f.map.handle({ type: "system", subtype: "init", tools: ["mcp__localdot__computer"] }),
    ).toEqual([{ kind: "started" }]);
  });
  it("accepts the connected apps' tools that localDot's own server offers", () => {
    const f = mapper();
    const app = "mcp__localdot__github__add_comment_to_pending_review";
    expect(
      f.map.handle({ type: "system", subtype: "init", tools: ["mcp__localdot__computer", app] }),
    ).toEqual([{ kind: "started" }]);
    expect(
      f.stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: app },
      }),
    ).toEqual([]);
    expect(
      f.map.handle({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", name: app }] },
      }),
    ).toEqual([]);
    for (const tools of [
      ["mcp__github__add_comment_to_pending_review"],
      ["mcp__localdot__not_a_tool"],
      ["mcp__other__github__list_issues"],
    ])
      expect(f.map.handle({ type: "system", subtype: "init", tools })).toEqual([
        { kind: "violation", what: "foreign_tool" },
      ]);
  });
});
