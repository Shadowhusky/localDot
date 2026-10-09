import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BrowserReadRequest, FileReadRequest, ShellRequest, webUrl } from "./desktopd-tools.ts";
import { parseEvent } from "./events.ts";
import { KeydBudget, KeydRouteModel, KeydRouteModels, LLM_PROVIDERS } from "./keyd.ts";
import {
  BootConfig,
  BrainEvent,
  BrainEvents,
  DEFAULT_AGENT_LIMITS,
  InboxReply,
  TranscriptAppend,
  TranscriptMessage,
} from "./tool-api.ts";
import { GenericComputerInput, isToolName, TOOL_INPUTS, TOOL_NAMES } from "./tools.ts";

const base = { v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: 0, t: 0, agent: "main" } as const;
const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";

describe("the v1 tool table", () => {
  it("names exactly the tools, including M7 screen switching and approved browser upload", () => {
    expect([...TOOL_NAMES]).toEqual([
      "computer",
      "shell",
      "files",
      "browser_read",
      "browser_navigate",
      "browser_upload",
      "switch_screen",
      "update_plan",
      "ask_user",
      "request_takeover",
      "remember",
      "done",
    ]);
    expect(isToolName("shell")).toBe(true);
    expect(isToolName("switch_screen")).toBe(true);
    expect(isToolName("browser_upload")).toBe(true);
    expect(TOOL_INPUTS.switch_screen.safeParse({ screen: "browser" }).success).toBe(true);
    expect(TOOL_INPUTS.switch_screen.safeParse({ screen: "desktop" }).success).toBe(true);
    for (const input of [{ screen: "other" }, { screen: "browser", cellId: ID }, { to: "browser" }])
      expect(TOOL_INPUTS.switch_screen.safeParse(input).success).toBe(false);
    for (const name of ["browser_script", "bash", "computer_20250124", "Shell", "__proto__"]) {
      expect(isToolName(name)).toBe(false);
    }
    expect(Object.keys(TOOL_INPUTS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("gives the generic computer tool a JSON Schema Gemini accepts: arrays, never tuples", () => {
    const schema = z.toJSONSchema(GenericComputerInput);
    expect(JSON.stringify(schema)).not.toContain("prefixItems");
    expect(schema).toMatchObject({
      properties: {
        coordinate: {
          minItems: 2,
          maxItems: 2,
          type: "array",
          items: { type: "number" },
        },
      },
    });
    expect(
      GenericComputerInput.safeParse({ action: "left_click", coordinate: [1, 2, 3] }).success,
    ).toBe(false);
  });

  it("describes a drag's path as an array of [x, y] arrays, with no tuple or union anywhere", () => {
    const schema = z.toJSONSchema(GenericComputerInput);
    const text = JSON.stringify(schema);
    for (const shape of ["prefixItems", "anyOf", "oneOf", "allOf"])
      expect(text).not.toContain(shape);
    expect(schema).toMatchObject({
      properties: {
        path: {
          type: "array",
          minItems: 2,
          maxItems: 64,
          items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
        },
        button: { type: "string", enum: ["left", "right", "middle"] },
      },
    });
    const drag = (path: number[][]) =>
      GenericComputerInput.safeParse({ action: "left_click_drag", path }).success;
    const points = (n: number) => Array.from({ length: n }, (_, i) => [i, i]);
    expect([drag(points(2)), drag(points(64))]).toEqual([true, true]);
    expect([
      drag(points(1)),
      drag(points(65)),
      drag([
        [1, 2, 3],
        [4, 5],
      ]),
    ]).toEqual([false, false, false]);
  });

  it("gives Codex's computer schema no tuple or union either", () => {
    const text = JSON.stringify(z.toJSONSchema(TOOL_INPUTS.computer));
    for (const shape of ["prefixItems", "anyOf", "oneOf", "allOf"])
      expect(text).not.toContain(shape);
  });

  it("refuses inputs outside a tool's schema", () => {
    expect(TOOL_INPUTS.shell.safeParse({ command: "" }).success).toBe(false);
    expect(TOOL_INPUTS.files.safeParse({ op: "chmod", path: "a" }).success).toBe(false);
    expect(
      TOOL_INPUTS.computer.safeParse({ action: "click", point: { x: 1.5, y: 2 } }).success,
    ).toBe(false);
    const keys = (repeat: number) =>
      TOOL_INPUTS.computer.safeParse({ action: "key", keys: ["Delete"], repeat }).success;
    expect([keys(1), keys(100), keys(101), keys(0)]).toEqual([true, true, false, false]);
    const computer = (input: Record<string, unknown>) =>
      TOOL_INPUTS.computer.safeParse(input).success;
    const path = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: i }));
    expect([
      computer({ action: "drag", path: path(2), button: "left", mods: ["shift"], ms: 800 }),
      computer({ action: "drag", path: path(64) }),
      computer({ action: "move", point: { x: 1, y: 2 } }),
      computer({ action: "mouse_down", button: "right" }),
      computer({ action: "mouse_up", point: { x: 1, y: 2 } }),
      computer({ action: "click", point: { x: 1, y: 2 }, mods: ["ctrl", "shift"], count: 3 }),
      computer({ action: "scroll", dy: 3, mods: ["ctrl"] }),
    ]).toEqual([true, true, true, true, true, true, true]);
    expect([
      computer({ action: "drag", path: path(1) }),
      computer({ action: "drag", path: path(65) }),
      computer({
        action: "drag",
        path: [
          { x: 1.5, y: 2 },
          { x: 3, y: 4 },
        ],
      }),
      computer({ action: "click", count: 4 }),
      computer({ action: "click", mods: [] }),
      computer({ action: "click", mods: ["a", "b", "c", "d", "e"] }),
      computer({ action: "left_click_drag" }),
    ]).toEqual([false, false, false, false, false, false, false]);
    expect(
      TOOL_INPUTS.ask_user.safeParse({
        question: "Which?",
        options: ["a", "b", "c", "d", "e", "f", "g"],
      }).success,
    ).toBe(false);
  });
});

describe("the tool API's shapes", () => {
  it("lets a brain append only its own event kinds", () => {
    expect(BrainEvent.safeParse({ type: "thought.delta", data: { text: "hm" } }).success).toBe(
      true,
    );
    expect(
      BrainEvent.safeParse({ type: "heartbeat", data: { ongoing: true, everyMs: 1000 } }).success,
    ).toBe(true);
    for (const type of [
      "action.intent",
      "key.use",
      "approval.resolve",
      "memory.change",
      "task.result",
      "session.end",
    ]) {
      expect(BrainEvent.safeParse({ type, data: {} }).success).toBe(false);
    }
  });

  it("reserves completion and user-wait state transitions for the daemon", () => {
    for (const state of ["thinking", "acting", "observing", "paused", "error"]) {
      expect(BrainEvent.safeParse({ type: "agent.state", data: { state } }).success).toBe(true);
    }
    for (const state of ["idle", "waiting_user", "done"]) {
      const event = { type: "agent.state", data: { state } };
      expect(BrainEvent.safeParse(event).success).toBe(false);
      expect(BrainEvents.safeParse({ events: [event] }).success).toBe(false);
      expect(parseEvent({ ...base, ...event }).type).toBe("agent.state");
    }
  });

  it("bounds append batches and inbox cursors used during restart recovery", () => {
    const message = { role: "user", content: "Follow up" };
    expect(TranscriptAppend.safeParse({ messages: Array(64).fill(message) }).success).toBe(true);
    expect(TranscriptAppend.safeParse({ messages: Array(65).fill(message) }).success).toBe(false);
    expect(TranscriptAppend.safeParse({ messages: [] }).success).toBe(false);
    const item = { seq: 2, messageId: ID, kind: "followup", text: "Compare the other option" };
    expect(InboxReply.parse({ items: [item], stopped: false }).items).toEqual([item]);
    expect(InboxReply.safeParse({ items: [{ ...item, seq: -1 }], stopped: false }).success).toBe(
      false,
    );
    expect(InboxReply.safeParse({ items: [{ ...item, seq: 1.5 }], stopped: false }).success).toBe(
      false,
    );
    expect(InboxReply.safeParse({ items: [{ ...item, seq: 0 }], stopped: false }).success).toBe(
      false,
    );
    expect(
      InboxReply.safeParse({ items: [{ ...item, messageId: "invalid" }], stopped: false }).success,
    ).toBe(false);
  });

  it("carries durable inbox identity only on user messages and allows acknowledgement retries", () => {
    const sourceInbox = { seq: 2, messageId: ID };
    const user = { role: "user", content: "Compare the other option", sourceInbox };
    expect(TranscriptAppend.parse({ messages: [user], inboxAfter: 2 })).toEqual({
      messages: [user],
      inboxAfter: 2,
    });
    expect(TranscriptAppend.parse({ messages: [], inboxAfter: 2 })).toEqual({
      messages: [],
      inboxAfter: 2,
    });
    for (const role of ["assistant", "tool"]) {
      expect(TranscriptMessage.safeParse({ ...user, role }).success).toBe(false);
      expect(TranscriptMessage.safeParse({ role, content: "ordinary transcript" }).success).toBe(
        true,
      );
    }
    for (const inboxAfter of [-1, 0.5]) {
      expect(TranscriptAppend.safeParse({ messages: [user], inboxAfter }).success).toBe(false);
    }
    for (const source of [
      { seq: 0, messageId: ID },
      { seq: 1.5, messageId: ID },
      { seq: 2, messageId: "invalid" },
      { ...sourceInbox, futureField: true },
    ]) {
      expect(TranscriptMessage.safeParse({ ...user, sourceInbox: source }).success).toBe(false);
    }
    expect(TranscriptAppend.safeParse({ messages: [], acknowledged: 2 }).success).toBe(false);
  });

  it("parses a boot config and refuses a malformed proxy token", () => {
    const boot = {
      sessionId: ID,
      task: "Compare flights",
      models: {
        main: {
          route: "anthropic",
          client: "anthropic",
          model: "claude-sonnet-5-5",
          surrogate: "ld_llm_0123456789abcdefghijkl_abcdef",
          computer: "anthropic-toolset",
          coords: "pixels",
          vision: true,
          reasoning: true,
          contextTokens: 200_000,
          maxOutputTokens: 64_000,
        },
      },
      proxy: { url: "http://172.30.0.10:3128", token: "a".repeat(43) },
      memory: { user: "", memory: "" },
      skills: [],
      limits: DEFAULT_AGENT_LIMITS,
      resume: false,
      inboxAfter: 0,
    };
    expect(BootConfig.parse(boot).models.main.route).toBe("anthropic");
    expect(
      BootConfig.safeParse({ ...boot, proxy: { ...boot.proxy, token: "short" } }).success,
    ).toBe(false);
    expect(
      BootConfig.safeParse({ ...boot, proxy: { ...boot.proxy, url: "https://x:3128" } }).success,
    ).toBe(false);
  });
});

describe("desktop tool wire", () => {
  it("permits a six-minute shell while enforcing the tool's bounded deadline", () => {
    expect(TOOL_INPUTS.shell.parse({ command: "long job", timeout_sec: 360 }).timeout_sec).toBe(
      360,
    );
    expect(ShellRequest.parse({ command: "long job", timeoutMs: 360_000 }).timeoutMs).toBe(360_000);
    expect(ShellRequest.parse({ command: "job" })).toMatchObject({
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
    });
    expect(ShellRequest.safeParse({ command: "job", timeoutMs: 600_001 }).success).toBe(false);
    expect(TOOL_INPUTS.shell.safeParse({ command: "job", timeout_sec: 601 }).success).toBe(false);
    expect(FileReadRequest.parse({ path: "notes.txt" }).maxBytes).toBe(256 * 1024);
    expect(BrowserReadRequest.parse({}).maxChars).toBe(20_000);
  });

  it("normalizes web addresses without interpreting other schemes as host names", () => {
    expect(webUrl("example.test/page?next=https://other.test")?.href).toBe(
      "https://example.test/page?next=https://other.test",
    );
    expect(webUrl("localhost:8080/page")?.href).toBe("https://localhost:8080/page");
    expect(webUrl("http://example.test")?.href).toBe("http://example.test/");
    for (const value of [
      "mailto:user@example.test",
      "file:/config/a",
      "file:///config/a",
      "javascript:alert(1)",
      "data:text/html,a",
      "chrome://settings",
      "devtools://devtools",
      "",
    ]) {
      expect(webUrl(value), value).toBeUndefined();
    }
  });
});

describe("keyd model and budget replies", () => {
  it("preserves all current presets and parses real route pricing fields", () => {
    expect(LLM_PROVIDERS).toEqual([
      "anthropic",
      "openai",
      "google",
      "xai",
      "mistral",
      "deepseek",
      "groq",
      "openrouter",
      "openai-compatible",
      "azure",
      "anthropic-compatible",
    ]);
    const model = {
      id: "provider/model",
      inputUSDPerMTok: 1,
      outputUSDPerMTok: 2,
      cacheReadUSDPerMTok: 0.25,
      cacheWriteUSDPerMTok: 1.25,
      maxOutputTokens: 4096,
    };
    expect(KeydRouteModels.parse({ route: "custom", models: [model], futureField: true })).toEqual({
      route: "custom",
      models: [model],
    });
    expect(KeydRouteModels.parse({ route: "custom", models: null }).models).toBeNull();
    expect(KeydRouteModel.safeParse({ ...model, outputUSDPerMTok: -1 }).success).toBe(false);
    expect(KeydRouteModel.safeParse({ ...model, maxOutputTokens: 100_000_001 }).success).toBe(
      false,
    );
    expect(
      KeydBudget.parse({ perTaskUSD: 5, perDayUSD: 20, day: { date: "2026-10-03", spentUSD: 0.5 } })
        .day.spentUSD,
    ).toBe(0.5);
  });
});

describe("agent events", () => {
  it("accepts the conversation, questions, hand-offs and results", () => {
    for (const [type, data] of [
      ["message.user", { messageId: ID, text: "Book it", kind: "task" }],
      ["message.delta", { messageId: ID, text: "Look" }],
      ["message.assistant", { messageId: ID, text: "Looking now." }],
      [
        "ask.request",
        {
          askId: ID,
          question: "Which date?",
          options: [{ key: "A", text: "Fri" }],
          allowText: true,
        },
      ],
      ["ask.answer", { askId: ID, option: "A", by: "user" }],
      ["takeover.request", { requestId: ID, reason: "login", note: "Sign in to the airline" }],
      ["takeover.end", { requestId: ID, by: "user", note: "done" }],
      [
        "task.result",
        { summary: "Done", files: [{ name: "a.ods", path: "/config/a.ods", bytes: 10 }] },
      ],
      [
        "model.usage",
        { role: "main", route: "anthropic", model: "m", inputTokens: 1, outputTokens: 2 },
      ],
      [
        "model.retry",
        { role: "main", attempt: 1, waitMs: 500, status: 529, message: "overloaded" },
      ],
      ["memory.change", { file: "USER.md", patch: "+x", changeId: ID }],
    ] as const) {
      expect(parseEvent({ ...base, type, data }).type).toBe(type);
    }
  });

  it("refuses an ask option outside A–F and an over-long question", () => {
    expect(() =>
      parseEvent({
        ...base,
        type: "ask.request",
        data: { askId: ID, question: "q", options: [{ key: "G", text: "x" }], allowText: false },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        ...base,
        type: "ask.request",
        data: { askId: ID, question: "q".repeat(1001), options: [], allowText: true },
      }),
    ).toThrow();
  });
});
