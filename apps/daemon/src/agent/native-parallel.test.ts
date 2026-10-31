import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type LocalDotEvent, ulid } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import type { ActionContext } from "../gateway/gateway.ts";
import { LiveSessions } from "../gateway/live.ts";
import { LOCALDOT_TOOLS } from "./claude-code/options.ts";
import type { FakeRun } from "./claude-code/testing/fake-claude-code.ts";
import type { McpEndpointInput } from "./codex/mcp-endpoint.ts";
import type { fakeCodex } from "./codex/testing/fake-codex.ts";
import { actPolicy } from "./policy.ts";
import { type AgentSettings, SettingsStore } from "./settings.ts";
import { type AgentWiringDeps, createAgent } from "./wiring.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=",
  "base64",
);
const m = vi.hoisted(() => ({
  runs: [] as FakeRun[],
  codex: undefined as ReturnType<typeof fakeCodex> | undefined,
  endpoints: [] as McpEndpointInput[],
  // What the first look answers each new conversation, through the fast model on the plan.
  look: JSON.stringify({ title: "Beat the game", dot: "coder", reason: "Needs scripts" }),
}));
// The SDK starts Claude Code before query() returns, as the real one does.
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => {
  const actual = await original<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const { FakeRun } = await import("./claude-code/testing/fake-claude-code.ts");
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: unknown; options: never }) => {
      if (typeof prompt === "string")
        return {
          close() {},
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", tools: [] };
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: m.look,
              usage: { input_tokens: 800, output_tokens: 70 },
            };
          },
        };
      const run = new FakeRun(prompt as never, options);
      m.runs.push(run);
      return run.query;
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { FakeChild } = await import("./claude-code/testing/fake-claude-code.ts");
  return { ...actual, spawn: () => new FakeChild() };
});
vi.mock("./claude-code/setup.ts", async (original) => ({
  ...(await original<typeof import("./claude-code/setup.ts")>()),
  ClaudeCodeSetup: class {
    async status() {
      return {
        state: "signed_in",
        models: [
          { id: "opus", name: "Claude Opus", efforts: ["low", "medium", "high"] },
          { id: "haiku", name: "Claude Haiku" },
        ],
      };
    }
    async launch() {
      return { executable: "/fixture/claude", env: { HOME: "/fixture" }, cwd: "/fixture/work" };
    }
    close() {}
  },
}));
vi.mock("../desktopd/tools-client.ts", async (original) => ({
  ...(await original<typeof import("../desktopd/tools-client.ts")>()),
  DesktopdTools: class {
    constructor(readonly endpoint: unknown) {}
    async close() {}
    async listDir() {
      return { path: "~/.skills", entries: [], truncated: false };
    }
    async putFile() {}
    async shell() {
      return { done: true, exitCode: 0, signal: null, timedOut: false, truncated: false, ms: 1 };
    }
    async prepareBrowser() {}
  },
}));
// The ChatGPT plan, set up and signed in, with Codex itself a fake.
vi.mock("@localdot/codex-harness", async (original) => ({
  ...(await original<typeof import("@localdot/codex-harness")>()),
  harnessAvailability: () => ({ available: true }),
  codexReleased: () => true,
  prepareOwnedCodexRoots: (home: string) => {
    const root = `${home}/codex`;
    return {
      root,
      home: `${root}/home`,
      binRoot: `${root}/bin`,
      workRoot: `${root}/work`,
      runRoot: `${root}/run`,
      profilesRoot: `${root}/profiles`,
    };
  },
}));
vi.mock("./codex/auth-owner.ts", async () => {
  const { fakeCodex } = await import("./codex/testing/fake-codex.ts");
  return {
    CodexAuthOwner: class {
      readonly fake = fakeCodex();
      readonly installer = {
        status: () => ({ state: "ready", version: "0.154.0" }),
        ensureInstalled: async () => ({ version: "0.154.0" }),
        verifiedInstallation: async () => undefined,
        cancel: () => {},
      };
      constructor() {
        m.codex = this.fake;
      }
      get authGeneration() {
        return this.fake.auth.authGeneration;
      }
      canResume(generation: number) {
        return this.fake.auth.canResume(generation);
      }
      markSignedOut(generation: number) {
        this.fake.auth.markSignedOut(generation);
      }
      acquireTask(sessionId: string, signal: AbortSignal) {
        return this.fake.auth.acquireTask(sessionId, signal);
      }
      async status() {
        return {
          available: true,
          state: "signed_in",
          codexVersion: "0.154.0",
          models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", isDefault: true }],
        };
      }
      async close() {}
    },
  };
});
vi.mock("./codex/setup.ts", async (original) => ({
  ...(await original<typeof import("./codex/setup.ts")>()),
  ChatgptSetup: class {
    reason() {
      return undefined;
    }
    async confirm(status: unknown) {
      return status;
    }
    ready() {
      return true;
    }
    async check() {}
    async close() {}
  },
}));
vi.mock("./codex/mcp-endpoint.ts", async (original) => ({
  ...(await original<typeof import("./codex/mcp-endpoint.ts")>()),
  openMcpEndpoint: async (input: McpEndpointInput) => {
    m.endpoints.push(input);
    return {
      dir: "/fixture/mcp",
      socket: "/fixture/mcp/m.sock",
      directory: {},
      setTurn() {},
      retireTurn() {},
      connections: () => 0,
      pauseAtBoundary: async () => {
        throw new Error("no Pause in this fixture");
      },
      validatePauseReceipt: () => false,
      close: async () => {},
    };
  },
}));
vi.mock("./brain-cell.ts", async (original) => ({
  ...(await original<typeof import("./brain-cell.ts")>()),
  BrainCells: class {
    async sweep() {
      return 0;
    }
    reservedPorts() {
      return [];
    }
  },
}));
vi.mock("@hono/node-server", () => ({
  serve: (_options: unknown, done: () => void) => {
    const server = Object.assign(new EventEmitter(), {
      listening: true,
      close: (fn?: () => void) => fn?.(),
    });
    setImmediate(done);
    return server;
  },
}));
vi.mock("./frame-png.ts", () => ({
  FramePng: class {
    async png() {
      return Buffer.from(PNG);
    }
  },
}));

const INIT = { type: "system", subtype: "init", tools: [...LOCALDOT_TOOLS] };
const CLAUDE: AgentSettings = {
  main: { provider: "claude-code", model: "opus", options: { reasoningEffort: "medium" } },
  fast: { provider: "claude-code", model: "haiku" },
  autoPersona: true,
};
const CHATGPT: AgentSettings = { main: { provider: "chatgpt", model: "gpt-6-astra" } };
const CLICK = { action: "click", point: { x: 300, y: 200 } };
const fixtures: (() => Promise<void>)[] = [];
beforeEach(() => {
  m.runs.length = 0;
  m.endpoints.length = 0;
  m.codex = undefined;
});
afterEach(async () => {
  for (const close of fixtures.splice(0)) await close();
  vi.restoreAllMocks();
});
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

// The production wiring and runner, with the user's setup: Claude Code Opus at medium effort as
// main, Claude Code Haiku as fast, Auto on. Only the computer, Claude Code and the model are fakes.
async function setup() {
  const base = mkdtempSync("/tmp/ld-native-parallel-"),
    home = join(base, "daemon");
  const log = new EventLog(home),
    live = new LiveSessions(),
    cellId = ulid();
  const cell: CellSummary = {
    id: cellId,
    state: "ready",
    scale: 2,
    createdAt: new Date().toISOString(),
    stream: NO_STREAM,
  };
  const settings = new SettingsStore(home);
  settings.put(CLAUDE);
  // A task's action holds the computer until the test lets it finish.
  const holds = new Map<string, () => void>();
  const acted: string[] = [];
  const gateway = {
    observe: vi.fn(async () => ({ frameId: ulid(), pointer: { x: 0, y: 0 } })),
    run: vi.fn(async (ctx: ActionContext) => {
      acted.push(ctx.sessionId);
      await new Promise<void>((resolve) => holds.set(ctx.sessionId, resolve));
      return { ok: true, frameId: ulid() };
    }),
    cursorOf: () => ({ x: 0, y: 0 }),
  };
  const deps: AgentWiringDeps = {
    home,
    installToken: "i".repeat(43),
    eventLog: log,
    live,
    policy: actPolicy,
    cells: {
      get: () => cell,
      list: () => [cell],
      record: () => undefined,
      endpoints: () => ({
        desktopd: { baseUrl: "http://127.0.0.1:1", token: "d".repeat(43) },
        stream: { baseUrl: "http://127.0.0.1:2", authorization: "fixture" },
      }),
      subscribe: () => () => {},
      reservedKeydPorts: () => [],
    },
    registry: { for: () => undefined },
    gateway: gateway as unknown as AgentWiringDeps["gateway"],
    frames: new FrameStore(home),
    docker: {} as AgentWiringDeps["docker"],
    keyd: {
      secrets: async () => [],
      beginTask: async () => {},
    } as unknown as AgentWiringDeps["keyd"],
    monitor: { health: { online: true, bootId: "fixture" } },
    killSwitch: { isBusy: () => false, contain: vi.fn(async () => undefined) },
    keydPorts: { from: 4791, to: 4796 },
    toolPort: 0,
    claudeCode: { realHome: join(base, "real-home") },
    codex: { realHome: join(base, "real-home"), user: "fixture" },
  };
  const agent = createAgent(deps);
  await agent.start();
  fixtures.push(async () => {
    for (const hold of holds.values()) hold();
    for (const session of agent.runner.sessions.values()) session.stop();
    for (const run of m.runs) run.query.close();
    await agent.close().catch(() => {});
    log.close();
    rmSync(base, { recursive: true, force: true });
  });
  const events = (id: string, type: LocalDotEvent["type"]) =>
    log
      .read(id)
      .filter((event) => event.type === type)
      .map((event) => event.data as Record<string, unknown>);
  // Which task each Claude Code run belongs to: the one whose start made it.
  const runs = new Map<FakeRun, string>();
  // Claude Code's run for a task, once it has the task's first prompt.
  const runOf = async (sessionId: string): Promise<FakeRun> => {
    const find = () => m.runs.find((r) => runs.get(r) === sessionId && r.prompts.length > 0);
    await until(() => !!find());
    const run = find();
    if (!run) throw new Error("no Claude Code run");
    return run;
  };
  const start = async (task: string, continues: string | null = null) => {
    const before = m.runs.length;
    const session = await agent.runner.start(cellId, task, undefined, { continues });
    await until(
      () =>
        m.runs.length > before ||
        events(session.id, "session.end").length > 0 ||
        events(session.id, "agent.state").some((s) => s.state === "error"),
    );
    const run = m.runs[before];
    if (run) runs.set(run, session.id);
    return session;
  };
  return {
    agent,
    live,
    cellId,
    holds,
    acted,
    events,
    start,
    runOf,
    use: (choice: AgentSettings) => settings.put(choice),
  };
}

describe("tasks of the user's Claude Code on one computer", () => {
  it("starts a new conversation's task while another acts, and lets it wait its turn", async () => {
    const f = await setup();
    const first = await f.start("Make a realistic animated pistol in Godot");
    const a = await f.runOf(first.id);
    a.emit(INIT);
    const acting = a.call("computer", CLICK);
    await until(() => f.acted.includes(first.id));
    expect(f.events(first.id, "agent.state")).toContainEqual({ state: "acting" });
    expect(f.live.lease(f.cellId).holder).toBe(first.id);

    const second = await f.start("Play The Binding of Isaac until you beat it once");
    expect(f.events(second.id, "persona.choice")).toContainEqual(
      expect.objectContaining({ persona: "coder", by: "auto" }),
    );
    expect(f.events(second.id, "agent.state").filter((s) => s.state === "error")).toEqual([]);
    expect(f.events(second.id, "session.end")).toEqual([]);
    const b = await f.runOf(second.id);
    b.emit(INIT);
    const content = b.prompts[0]?.message.content as { type: string; text?: string }[];
    expect(content[0]?.text).toContain("Binding of Isaac");
    expect(content[1]).toMatchObject({ type: "image" });

    // Its first action waits for the first task's to end, then runs.
    const waiting = b.call("computer", CLICK);
    await until(() => f.live.lease(f.cellId).waiting().includes(second.id));
    expect(f.acted).toEqual([first.id]);
    f.holds.get(first.id)?.();
    await acting;
    await until(() => f.acted.includes(second.id));
    expect(f.live.lease(f.cellId).holder).toBe(second.id);
    f.holds.get(second.id)?.();
    expect((await waiting).isError).toBeFalsy();
  });

  it("starts a task that continues a finished conversation while another acts", async () => {
    const f = await setup();
    const first = await f.start("Make a realistic animated pistol in Godot");
    const a = await f.runOf(first.id);
    a.emit(INIT);
    void a.call("computer", CLICK);
    await until(() => f.acted.includes(first.id));
    const second = await f.start("Play The Binding of Isaac until you beat it once");
    const b = await f.runOf(second.id);
    b.emit(INIT);
    await b.call("done", { summary: "Stopped before the first floor." });
    await until(() => f.events(second.id, "agent.state").some((s) => s.state === "done"));

    const retry = await f.start("Retry", second.id);
    expect(f.events(retry.id, "agent.state").filter((s) => s.state === "error")).toEqual([]);
    const c = await f.runOf(retry.id);
    const content = c.prompts[0]?.message.content as { type: string; text?: string }[];
    expect(content[0]?.text).toContain("Retry");
    expect(f.live.lease(f.cellId).holder).toBe(first.id);
  });
});

describe("a ChatGPT task on a computer a Claude Code task is using", () => {
  it("starts at once and waits its turn to act", async () => {
    const f = await setup();
    const first = await f.start("Make a realistic animated pistol in Godot");
    const a = await f.runOf(first.id);
    a.emit(INIT);
    const acting = a.call("computer", CLICK);
    await until(() => f.acted.includes(first.id));

    f.use(CHATGPT);
    const second = await f.agent.runner.start(f.cellId, "Book a table for two", undefined, {
      continues: null,
    });
    const codex = m.codex;
    if (!codex) throw new Error("no ChatGPT account");
    const conn = await codex.nextLaunch(1);
    await conn.waitFor("turn/start");
    expect(f.events(second.id, "agent.state").filter((s) => s.state === "error")).toEqual([]);
    const input = m.endpoints.find((e) => e.session.id === second.id);
    if (!input) throw new Error("no ChatGPT tool endpoint");
    const basis = f.agent.runner.get(second.id)?.lastFrameId ?? "";
    const epoch = { id: input.generation.id, signal: input.signal, basisFrameId: basis };
    const waiting = input.dispatch(
      "computer",
      ulid(),
      { ...CLICK, basedOn: basis },
      {
        generation: input.generation,
        authGeneration: input.authGeneration,
        turnEpoch: epoch,
        basisFrameId: basis,
        connection: {},
        requestId: 1,
        signal: input.signal,
      },
    );
    await until(() => f.live.lease(f.cellId).waiting().includes(second.id));
    expect(f.acted).toEqual([first.id]);
    f.holds.get(first.id)?.();
    await acting;
    await until(() => f.acted.includes(second.id));
    f.holds.get(second.id)?.();
    expect((await waiting).result.ok).toBe(true);
  });
});
