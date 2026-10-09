import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { Options, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { parseEvent, TOOL_NAMES, type ToolResult, ulid } from "@localdot/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { TranscriptStore } from "../transcript.ts";
import {
  CLAUDE_CODE_CRASHED,
  CLAUDE_CODE_DONE,
  CLAUDE_CODE_GAVE_UP,
  ClaudeCodeDriver,
  type ClaudeCodeDriverDeps,
  type QueryFn,
} from "./driver.ts";
import { LOCALDOT_TOOLS } from "./options.ts";
import { ClaudeCodeUnavailable } from "./setup.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=",
  "base64",
);
const INIT = { type: "system", subtype: "init", tools: [...LOCALDOT_TOOLS] };
const turn = (model = "claude-sonnet-5-5") => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "message_start", message: { model, usage: { input_tokens: 100 } } },
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  kill(signal: NodeJS.Signals): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }
}
// One mocked Claude Code process: the SDK's query, its prompt stream and its MCP connection.
class FakeRun {
  readonly prompts: SDKUserMessage[] = [];
  readonly child: FakeChild;
  readonly #queue: unknown[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  closed = false;
  #mcp: Client | undefined;
  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const message of prompt) this.prompts.push(message);
    })();
    this.child = options.spawnClaudeCodeProcess?.({
      command: options.pathToClaudeCodeExecutable ?? "",
      args: [],
      cwd: options.cwd,
      env: options.env ?? {},
      signal: new AbortController().signal,
    }) as unknown as FakeChild;
  }
  readonly query = {
    close: () => {
      this.closed = true;
      this.child.kill("SIGTERM");
      this.end();
    },
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        for (;;) {
          if (this.#queue.length) return { done: false, value: this.#queue.shift() };
          if (this.#ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
      },
    }),
  };
  emit(...messages: unknown[]): void {
    this.#queue.push(...messages);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  async mcp(): Promise<Client> {
    if (this.#mcp) return this.#mcp;
    const server = this.options.mcpServers?.localdot;
    if (server?.type !== "sdk" || !("instance" in server)) throw new Error("no server");
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(transport);
    this.#mcp = new Client({ name: "fixture", version: "1.0.0" });
    await this.#mcp.connect(client);
    return this.#mcp;
  }
  async call(name: string, args: Record<string, unknown>) {
    return (await this.mcp()).callTool({ name, arguments: args });
  }
}

const firstText = (run: FakeRun) =>
  (run.prompts[0]?.message.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
function fixture(deps: Partial<ClaudeCodeDriverDeps> = {}) {
  const home = mkdtempSync("/tmp/ld-claude-driver-"),
    transcripts = new TranscriptStore(home),
    events: { type: string; data: Record<string, unknown> }[] = [];
  const session = new AgentSession(ulid(), ulid(), "Draw a dog", {
    append: (_id, draft) => {
      const event = parseEvent({ v: 1, id: ulid(), seq: events.length, t: 0, ...draft });
      events.push({ type: event.type, data: event.data } as never);
      return event;
    },
  });
  const runs: FakeRun[] = [];
  const query = vi.fn<QueryFn>(({ prompt, options }) => {
    const run = new FakeRun(prompt, options);
    runs.push(run);
    return run.query;
  });
  const frames: string[] = [];
  const observe = vi.fn(async () => {
    const frameId = ulid();
    frames.push(frameId);
    return { frameId, full: true as const, png: Buffer.from(PNG) };
  });
  const dispatch = vi.fn<ClaudeCodeDriverDeps["dispatch"]>(
    async (_session, _generation, name): Promise<ToolResult> => {
      if (name === "done") return { ok: true, final: true, content: [] };
      if (name === "computer") {
        const frameId = ulid();
        frames.push(frameId);
        return {
          ok: true,
          content: [
            { type: "image", frameId, mediaType: "image/png", data: PNG.toString("base64") },
          ],
        };
      }
      return { ok: true, content: [{ type: "text", text: "Done." }] };
    },
  );
  const launch = vi.fn(async () => ({
    executable: "/Users/person/.local/bin/claude",
    env: { HOME: "/Users/person", PATH: "/Users/person/.local/bin:/usr/bin" },
    cwd: `${home}/work`,
    plan: "max",
  }));
  const driver = new ClaudeCodeDriver({
    query,
    launch,
    spawn: () => new FakeChild() as unknown as SpawnedProcess,
    dispatch,
    observe,
    transcripts,
    instructions: () => "Only localdot tools.",
    redactorFor: () => redactor(["fake-private-diagnostic"]),
    sleep: vi.fn(async () => {}),
    heartbeatMs: 10,
    startupMs: 1000,
    exitMs: 100,
    ...deps,
  });
  const running: Promise<number>[] = [];
  const run = (resume = false) => {
    const promise = driver.run(session, { model: "sonnet", resume });
    running.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  cleanups.push(async () => {
    session.stop();
    for (const promise of running) await promise.catch(() => {});
    for (const fake of runs) fake.query.close();
    rmSync(home, { recursive: true, force: true });
  });
  const started = async (index = 0) => {
    await until(() => runs.length > index && (runs[index]?.prompts.length ?? 0) > 0);
    const fake = runs[index];
    if (!fake) throw new Error("no run");
    fake.emit(INIT, turn());
    return fake;
  };
  const states = () =>
    events.filter((e) => e.type === "agent.state").map((e) => e.data as Record<string, unknown>);
  return {
    session,
    driver,
    run,
    runs,
    query,
    dispatch,
    observe,
    launch,
    frames,
    events,
    states,
    transcripts,
    started,
  };
}

describe("Claude Code driver", () => {
  it("runs dot on the user's Claude Code with only localDot's tools, and ends on done", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    const options = f.query.mock.calls[0]?.[0].options;
    expect(options?.settingSources).toEqual([]);
    expect(options?.tools).toEqual([]);
    expect(options?.allowedTools).toBeUndefined();
    expect(options?.disallowedTools).toContain("Bash");
    expect(options?.pathToClaudeCodeExecutable).toBe("/Users/person/.local/bin/claude");
    expect(options?.model).toBe("sonnet");
    expect(options?.systemPrompt).toBe("Only localdot tools.");
    const first = fake.prompts[0]?.message.content as { type: string; text?: string }[];
    expect(first[0]).toMatchObject({ type: "text", text: "Draw a dog" });
    expect(first[1]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    const tools = await (await fake.mcp()).listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    await fake.call("shell", { command: "ls" });
    expect(f.dispatch).toHaveBeenLastCalledWith(
      f.session,
      expect.anything(),
      "shell",
      expect.stringMatching(/^claude-/),
      { command: "ls" },
      expect.any(AbortSignal),
    );
    await fake.call("done", { summary: "Drew a dog." });
    expect(await result).toBe(CLAUDE_CODE_DONE);
    expect(fake.closed).toBe(true);
    expect(fake.child.killed).toBe(true);
    expect(f.driver.retirementConfirmed(f.session.id)).toBe(true);
    expect(f.session.generation).toBeUndefined();
  });

  it("checks each action against the newest screenshot dot had seen when it chose it", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    const click = {
      action: "click",
      point: { x: 10, y: 10 },
      basedOn: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    };
    await fake.call("computer", click);
    const basis = () =>
      (f.dispatch.mock.lastCall?.[4] as { basedOn?: string } | undefined)?.basedOn;
    expect(basis()).toBe(f.frames[0]);
    // The same reply's next action was chosen before the new screenshot came back.
    await fake.call("computer", click);
    expect(basis()).toBe(f.frames[0]);
    fake.emit(turn());
    await until(() => f.states().filter((s) => s.state === "thinking").length >= 2);
    await fake.call("computer", click);
    expect(basis()).toBe(f.frames[2]);
    await fake.call("done", { summary: "ok" });
    expect(await result).toBe(CLAUDE_CODE_DONE);
  });

  it("stops the task when Claude Code offers any tool that is not localDot's", async () => {
    const f = fixture();
    const result = f.run();
    await until(() => (f.runs[0]?.prompts.length ?? 0) > 0);
    const fake = f.runs[0] as FakeRun;
    fake.emit({ ...INIT, tools: [...LOCALDOT_TOOLS, "Bash"] });
    expect(await result).toBe(CLAUDE_CODE_GAVE_UP);
    expect(f.states().at(-1)).toEqual({
      state: "error",
      reason: "Claude Code used a tool that is not localDot's; localDot stopped the task",
    });
    expect(fake.closed).toBe(true);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("stops the task when Claude Code calls a foreign tool or starts a sub-agent", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    fake.emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Read" },
      },
    });
    expect(await result).toBe(CLAUDE_CODE_GAVE_UP);
    const g = fixture();
    const second = g.run();
    const other = await g.started();
    other.emit({ type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [] } });
    expect(await second).toBe(CLAUDE_CODE_GAVE_UP);
    expect(g.states().at(-1)?.reason).toBe(
      "Claude Code started a sub-agent; localDot stopped the task",
    );
  });

  it("refuses tool calls once the run is over", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    await fake.call("done", { summary: "ok" });
    await result;
    const late = await fake.call("shell", { command: "rm -rf ~" });
    expect(late.isError).toBe(true);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("waits for the user to sign in to Claude Code again, then continues from the history", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    fake.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [] },
      error: "authentication_failed",
    });
    await until(() => f.states().some((s) => s.reason === "claude code sign-in expired"));
    expect(fake.closed).toBe(true);
    f.session.post("resume", "");
    const next = await f.started(1);
    const recap = firstText(next);
    expect(recap).toContain("localDot restarted you");
    expect(recap).toContain("Draw a dog");
    await next.call("done", { summary: "ok" });
    expect(await result).toBe(CLAUDE_CODE_DONE);
  });

  it("pauses without starting Claude Code when it is signed out", async () => {
    const f = fixture({
      launch: vi.fn(async () => {
        throw new ClaudeCodeUnavailable({ state: "signed_out", models: [] });
      }),
    });
    const result = f.run();
    await until(() => f.states().some((s) => s.reason === "claude code sign-in expired"));
    expect(f.query).not.toHaveBeenCalled();
    f.session.stop();
    expect(await result).toBe(CLAUDE_CODE_DONE);
  });

  it("shows the plan's limits and waits when the plan is used up", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    fake.emit(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
          resetsAt: 1_900_000_000,
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [] },
        error: "rate_limit",
      },
    );
    await until(() => f.states().some((s) => s.reason === "claude code plan limit reached"));
    expect(f.events.find((e) => e.type === "subscription.usage")?.data).toEqual({
      provider: "claude-code",
      plan: "max",
      windows: [
        { window: "primary", usedPercent: 100, windowMinutes: 300, resetsAt: 1_900_000_000 },
      ],
      limitReached: true,
    });
    expect(f.events.some((e) => e.type === "model.spend")).toBe(false);
    f.session.stop();
    expect(await result).toBe(CLAUDE_CODE_DONE);
  });

  it("streams dot's words and reports token use as plan usage", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    const block = (event: Record<string, unknown>) => ({
      type: "stream_event",
      parent_tool_use_id: null,
      event,
    });
    fake.emit(
      block({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      block({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Opening " },
      }),
      block({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "the paint app." },
      }),
      block({ type: "content_block_stop", index: 0 }),
      block({ type: "message_delta", usage: { output_tokens: 42 } }),
    );
    await until(() => f.events.some((e) => e.type === "model.usage"));
    const said = f.events.find((e) => e.type === "message.assistant")?.data;
    expect(said?.text).toBe("Opening the paint app.");
    expect(
      f.events
        .filter((e) => e.type === "message.delta")
        .map((e) => e.data.text)
        .join(""),
    ).toBe("Opening the paint app.");
    expect(f.events.find((e) => e.type === "model.usage")?.data).toEqual({
      role: "main",
      route: "claude-code",
      model: "claude-sonnet-5-5",
      inputTokens: 100,
      outputTokens: 42,
    });
    expect(
      f.transcripts.read(f.session.id).some((m) => m.content === "Opening the paint app."),
    ).toBe(true);
    await fake.call("done", { summary: "ok" });
    expect(await result).toBe(CLAUDE_CODE_DONE);
  });

  it("hands the user's messages to the running Claude Code", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    f.session.post("steer", "Make it brown");
    await until(() => fake.prompts.length === 2);
    expect(fake.prompts[1]?.message.content).toBe("Make it brown");
    expect(f.transcripts.read(f.session.id).some((m) => m.content === "Make it brown")).toBe(true);
    f.session.post("steer", "And add a hat");
    await until(() => fake.prompts.length === 3);
    // A reply that took in the first message; the second has not been seen yet.
    fake.emit({ ...turn(), user_message_uuid: fake.prompts[1]?.uuid });
    await fake.call("done", { summary: "ok" });
    // The message was never seen to reach a reply, so the task carries on with it.
    await until(() => f.runs.length === 2);
    const next = await f.started(1);
    const recap = firstText(next);
    expect(recap).toContain("Make it brown");
    expect(recap).toContain("And add a hat");
    expect(recap).toContain("Continue with the user's follow-up.");
    await next.call("done", { summary: "ok" });
    expect(await result).toBe(CLAUDE_CODE_DONE);
  });

  it("nudges once when a reply ends without done, then rests", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    fake.emit({ type: "result", subtype: "success", is_error: false });
    await until(() => fake.prompts.length === 2);
    expect(fake.prompts[1]?.message.content).toContain("call the localdot done tool");
    fake.emit({ type: "result", subtype: "success", is_error: false });
    expect(await result).toBe(CLAUDE_CODE_GAVE_UP);
    expect(f.states().at(-1)).toEqual({ state: "idle", reason: "no result" });
  });

  it("reports a crash when Claude Code exits on its own", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    fake.child.kill("SIGKILL");
    expect(await result).toBe(CLAUDE_CODE_CRASHED);
  });

  it("retires Claude Code at Stop and on the user's takeover", async () => {
    const f = fixture();
    const result = f.run();
    const fake = await f.started();
    f.session.stop();
    expect(await result).toBe(CLAUDE_CODE_DONE);
    expect(fake.closed).toBe(true);
    const g = fixture();
    const taken = g.run();
    const held = await g.started();
    g.session.takeControl();
    await until(() => held.closed);
    expect(g.session.generation).toBeUndefined();
    g.session.stop();
    expect(await taken).toBe(CLAUDE_CODE_DONE);
  });

  it("settles its calls and retires Claude Code for a Pause, with a receipt", async () => {
    const f = fixture();
    void f.run();
    const fake = await f.started();
    await fake.call("shell", { command: "ls" });
    const pause = f.session.requestSafetyPause(ulid());
    const receipt = await f.driver.pauseAtBoundary(f.session, pause);
    expect(receipt).toMatchObject({
      sessionId: f.session.id,
      requestId: pause.requestId,
      turnRetired: true,
      callsSettled: true,
      completedCalls: 1,
    });
    expect(fake.closed).toBe(true);
    const refused = await fake.call("shell", { command: "ls" });
    expect(refused.isError).toBe(true);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});
