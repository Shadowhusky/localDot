import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  CODEX_MANIFEST_SHA256,
  CODEX_VERSION,
  CodexInstallError,
  type CodexInstaller,
  type HarnessAvailability,
  NativeCheckError,
  stampAccount,
  stampNative,
} from "@localdot/codex-harness";
import { type ScreenName, ulid } from "@localdot/protocol";
import { CHECK_MEMORY_FIRST } from "@localdot/protocol/guidance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenController, ScreenScope } from "../browser/screen-controller.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { ClaudeCodeDriverDeps } from "./claude-code/driver.ts";
import type { CodexAuthOwnerDeps } from "./codex/auth-owner.ts";
import type { CodexDriverDeps } from "./codex/driver.ts";
import type { McpEndpointInput } from "./codex/mcp-endpoint.ts";
import { SANDBOX_REASONS } from "./codex/setup.ts";
import { MemoryStore } from "./memory.ts";
import { AgentSession } from "./session.ts";
import type { ToolApiDeps } from "./tool-api.ts";
import { type AgentWiringDeps, createAgent } from "./wiring.ts";

const m = vi.hoisted(() => ({
  owner: undefined as CodexAuthOwnerDeps | undefined,
  driver: undefined as CodexDriverDeps | undefined,
  claude: undefined as ClaudeCodeDriverDeps | undefined,
  tool: undefined as ToolApiDeps | undefined,
  toolApp: undefined as ReturnType<typeof import("./tool-api.ts")["createToolApi"]> | undefined,
  endpoints: [] as McpEndpointInput[],
  available: { available: true } as HarnessAvailability,
  record: {} as Record<string, unknown>,
  host: { system: "25G83", runtime: "0.0.78" },
  check: vi.fn(),
  installed: false,
  ensure: vi.fn(),
  verify: vi.fn(),
  cancel: vi.fn(),
  authClose: vi.fn(),
  status: vi.fn(),
  run: vi.fn(),
  sweep: vi.fn(),
  serve: vi.fn(),
  png: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@localdot/codex-harness", async (original) => ({
  ...(await original<typeof import("@localdot/codex-harness")>()),
  harnessAvailability: () => m.available,
  checkHost: () => m.host,
  checkNativeSandbox: (...args: unknown[]) => m.check(...args),
}));
vi.mock("../../../../harness/codex/acceptance/record.json", () => ({ default: m.record }));
vi.mock("@hono/node-server", () => ({ serve: (...args: unknown[]) => m.serve(...args) }));
vi.mock("./brain-cell.ts", async (original) => ({
  ...(await original<typeof import("./brain-cell.ts")>()),
  BrainCells: class {
    sweep() {
      return m.sweep();
    }
    reservedPorts() {
      return [4796];
    }
  },
}));
vi.mock("./codex/auth-owner.ts", () => ({
  CodexAuthOwner: class {
    authGeneration = 1;
    readonly installer: CodexInstaller = {
      status: () =>
        m.installed ? { state: "ready", version: "0.154.0" } : { state: "not_installed" },
      ensureInstalled: (signal) => m.ensure(signal),
      verifiedInstallation: (signal) => m.verify(signal),
      cancel: () => m.cancel(),
    };
    constructor(d: CodexAuthOwnerDeps) {
      m.owner = d;
    }
    status(...args: unknown[]) {
      return m.status(...args);
    }
    close() {
      return m.authClose();
    }
  },
}));
vi.mock("./codex/driver.ts", async (original) => ({
  ...(await original<typeof import("./codex/driver.ts")>()),
  CodexDriver: class {
    constructor(d: CodexDriverDeps) {
      m.driver = d;
    }
    run(...args: unknown[]) {
      return m.run(...args);
    }
  },
}));
vi.mock("./claude-code/driver.ts", async (original) => ({
  ...(await original<typeof import("./claude-code/driver.ts")>()),
  ClaudeCodeDriver: class {
    constructor(d: ClaudeCodeDriverDeps) {
      m.claude = d;
    }
    run(...args: unknown[]) {
      return m.run(...args);
    }
  },
}));
vi.mock("./codex/mcp-endpoint.ts", async (original) => ({
  ...(await original<typeof import("./codex/mcp-endpoint.ts")>()),
  openMcpEndpoint: async (input: McpEndpointInput) => {
    m.endpoints.push(input);
    return {
      dir: input.roots.runRoot,
      socket: join(input.roots.runRoot, "fake.sock"),
      directory: {},
      setTurn() {},
      retireTurn() {},
      connections: () => 0,
      close: async () => {},
    };
  },
}));
vi.mock("./frame-png.ts", () => ({
  FramePng: class {
    png(...args: unknown[]) {
      return m.png(...args);
    }
  },
}));
vi.mock("./tools/index.ts", async (original) => {
  const actual = await original<typeof import("./tools/index.ts")>();
  return {
    ...actual,
    dispatchTool: (...args: Parameters<typeof actual.dispatchTool>) => {
      m.dispatch(...args);
      return actual.dispatchTool(...args);
    },
  };
});
vi.mock("./tool-api.ts", async (original) => {
  const actual = await original<typeof import("./tool-api.ts")>();
  return {
    ...actual,
    createToolApi: (d: ToolApiDeps) => {
      m.tool = d;
      m.toolApp = actual.createToolApi(d);
      return m.toolApp;
    },
  };
});
function required<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("fixture missing value");
  return x;
}
function gate<T>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const fixtures: { agent: ReturnType<typeof createAgent>; log: EventLog; base: string }[] = [];
beforeEach(() => {
  for (const fn of [
    m.check,
    m.ensure,
    m.verify,
    m.cancel,
    m.authClose,
    m.status,
    m.run,
    m.sweep,
    m.serve,
    m.png,
    m.dispatch,
  ])
    fn.mockReset();
  m.owner = undefined;
  m.driver = undefined;
  m.claude = undefined;
  m.tool = undefined;
  m.toolApp = undefined;
  m.endpoints.length = 0;
  m.available = { available: true };
  for (const key of Object.keys(m.record)) delete m.record[key];
  m.installed = false;
  m.verify.mockImplementation(async () =>
    m.installed
      ? {
          version: "0.154.0",
          platform: "darwin-arm64",
          binDir: "/owned/bin/x",
          codexBin: "/owned/bin/x/codex",
          codeModeHostBin: "/owned/bin/x/codex-code-mode-host",
        }
      : undefined,
  );
  m.check.mockImplementation(async () => ({ host: m.host, reportSha256: "c".repeat(64) }));
  m.ensure.mockResolvedValue({ version: "0.154.0" });
  m.authClose.mockResolvedValue(undefined);
  m.sweep.mockResolvedValue(0);
  m.status.mockResolvedValue({ available: true, state: "signed_in", codexVersion: "0.154.0" });
  m.png.mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  m.serve.mockImplementation((_opts: unknown, done: () => void) => {
    const server = new EventEmitter() as EventEmitter & {
      listening: boolean;
      close: (fn?: (err?: Error) => void) => void;
    };
    server.listening = true;
    server.close = (fn) => {
      server.listening = false;
      fn?.();
    };
    setImmediate(done);
    return server;
  });
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.agent.close().catch(() => {});
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function setup(
  options: { codex?: boolean; claude?: boolean; unsafe?: boolean; record?: unknown } = {},
) {
  const base = mkdtempSync("/tmp/ld12-wire-"),
    home = join(base, "daemon"),
    realHome = join(base, "real-home");
  // prepareOwnedCodexRoots requires a real owned home; all fixtures stay inside one temporary root.
  const real = new EventLog(realHome);
  real.close();
  const log = new EventLog(home),
    live = new LiveSessions(),
    cellId = ulid(),
    frameId = ulid();
  if (options.unsafe) symlinkSync(realHome, join(home, "codex"));
  if (options.record) {
    mkdirSync(join(home, "codex"), { mode: 0o700 });
    writeFileSync(join(home, "codex", "acceptance.json"), JSON.stringify(options.record), {
      mode: 0o600,
    });
  }
  let endpoint = { baseUrl: "http://127.0.0.1:1", token: "d".repeat(43) };
  let cell: CellSummary = {
    id: cellId,
    state: "ready",
    scale: 1,
    createdAt: new Date().toISOString(),
    stream: NO_STREAM,
  };
  const state = { busy: false, online: true },
    listeners = new Set<(c: CellSummary) => void>();
  const observe = vi.fn(async (_input: unknown) => ({ frameId }));
  const policy = {
    decide: vi.fn(async () => ({ kind: "deny" as const, reason: "fixture policy refusal" })),
  };
  const deps: AgentWiringDeps = {
    home,
    installToken: "i".repeat(43),
    eventLog: log,
    live,
    policy,
    cells: {
      get: () => cell,
      list: () => [cell],
      record: () => undefined,
      endpoints: () => ({
        desktopd: endpoint,
        stream: { baseUrl: "http://127.0.0.1:2", authorization: "fixture" },
      }),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      reservedKeydPorts: () => [4791],
    },
    registry: { for: () => undefined },
    gateway: { observe } as unknown as AgentWiringDeps["gateway"],
    frames: new FrameStore(home),
    docker: {} as AgentWiringDeps["docker"],
    keyd: {
      secrets: vi.fn(async () => {
        throw new Error("no paid key read");
      }),
    } as unknown as AgentWiringDeps["keyd"],
    monitor: {
      get health() {
        return { online: state.online, bootId: "fixture" };
      },
    },
    killSwitch: { isBusy: () => state.busy, stopSession: vi.fn(async () => undefined) },
    keydPorts: { from: 4791, to: 4796 },
    toolPort: 0,
    ...(options.codex === false ? {} : { codex: { realHome, user: "fixture" } }),
    ...(options.claude ? { claudeCode: { realHome } } : {}),
  };
  const agent = createAgent(deps);
  fixtures.push({ agent, log, base });
  const session = () => {
    const id = log.createSession("Fixture task"),
      s = new AgentSession(id, cellId, "Fixture task", log);
    agent.runner.sessions.set(id, s);
    return s;
  };
  return {
    agent,
    log,
    home,
    realHome,
    deps,
    policy,
    state,
    observe,
    frameId,
    cellId,
    session,
    rotate: () => {
      endpoint = { ...endpoint, token: "n".repeat(43) };
    },
    change: (patch: Partial<CellSummary>) => {
      cell = { ...cell, ...patch };
      for (const fn of listeners) fn(cell);
    },
  };
}

describe("the desktop's sign-in page", () => {
  it("is found from the page's address alone, running nothing in the user's page", async () => {
    const f = setup();
    const asked: string[] = [];
    const desktopd = createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: "https://accounts.google.com/signin" }));
    });
    await new Promise<void>((resolve) => desktopd.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = desktopd.address() as AddressInfo;
      f.deps.cells.endpoints = () => ({
        desktopd: { baseUrl: `http://127.0.0.1:${port}`, token: "d".repeat(43) },
        stream: { baseUrl: "http://127.0.0.1:2", authorization: "fixture" },
      });
      await f.agent.start();
      const page = await f.agent.routes.desktopPage?.(f.cellId, new AbortController().signal);
      expect(page).toBe("https://accounts.google.com/signin");
      expect(asked).toEqual(["GET /browser/page"]);
    } finally {
      desktopd.close();
    }
  });
});

describe("ChatGPT production integration", () => {
  it("performs no eager install/account/process work, and only verifies existing installation at startup", async () => {
    const f = setup();
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.ensure).not.toHaveBeenCalled();
    expect(m.status).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    await f.agent.start();
    expect(m.verify).toHaveBeenCalledTimes(1);
    expect(m.ensure).not.toHaveBeenCalled();
    expect(m.status).not.toHaveBeenCalled();
    expect(m.check).not.toHaveBeenCalled();
  });
  const released = () => ({
    format: 1,
    codexVersion: CODEX_VERSION,
    platform: `${process.platform}-${process.arch}`,
    manifestSha256: CODEX_MANIFEST_SHA256,
    nativeSandbox: { passed: true, inputSha256: "a".repeat(64), reportSha256: "b".repeat(64) },
    realAccount: { passed: false },
  });
  const pending = {
    available: false,
    reason: "ChatGPT plan support isn't switched on in this version yet.",
  };
  const signedIn = {
    available: true,
    state: "signed_in",
    codexVersion: "0.154.0",
    account: { email: "person@example.test", plan: "plus" },
  };
  const choose = (f: ReturnType<typeof setup>) =>
    f.agent.routes.settings.put({ main: { provider: "chatgpt", model: "gpt-6-astra" } });
  const recordOf = (f: ReturnType<typeof setup>) =>
    JSON.parse(readFileSync(join(f.home, "codex", "acceptance.json"), "utf8"));
  it.each([
    ["no record", {}],
    ["no native sandbox stamp", { nativeSandbox: { passed: false } }],
    ["another Codex version", { codexVersion: "0.155.0" }],
    ["another release manifest", { manifestSha256: "0".repeat(64) }],
  ])("keeps the plan switched off without release evidence: %s", async (name, patch) => {
    if (name !== "no record") Object.assign(m.record, released(), patch);
    m.installed = true;
    const f = setup();
    await f.agent.start();
    expect(f.agent.routes.harness?.()).toEqual(pending);
    choose(f);
    await expect(f.agent.runner.start(f.cellId, "Fixture task")).rejects.toMatchObject({
      status: 400,
    });
    expect(m.check).not.toHaveBeenCalled();
    expect(m.status).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    expect(m.ensure).not.toHaveBeenCalled();
  });
  it("lets the plan be chosen and set up with the release evidence, before this Mac's stamps", async () => {
    Object.assign(m.record, released());
    const f = setup();
    await f.agent.start();
    expect(f.agent.routes.harness?.()).toEqual({ available: true });
    expect(f.agent.routes.chatgpt?.availability()).toEqual({ available: true });
    expect(f.agent.routes.chatgpt?.setup.sandbox()).toBe("unchecked");
    choose(f);
    await expect(f.agent.runner.start(f.cellId, "Fixture task")).rejects.toMatchObject({
      status: 400,
      message: "Install ChatGPT support first.",
    });
    m.available = { available: false, reason: "fixture unsupported platform" };
    expect(f.agent.routes.harness?.()).toEqual(m.available);
  });
  it("checks this Mac's sandbox at startup, then opens tasks after the first verified sign-in", async () => {
    Object.assign(m.record, released());
    m.installed = true;
    const f = setup();
    // Every Codex launch, for the account or a task, stays closed until this Mac's check passes.
    expect(m.owner?.sandboxReason?.()).toBe(SANDBOX_REASONS.unchecked);
    await f.agent.start();
    const plan = f.agent.routes.chatgpt?.setup;
    await vi.waitFor(() => expect(plan?.sandbox()).toBe("passed"));
    expect(m.owner?.sandboxReason?.()).toBeUndefined();
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(recordOf(f)).toMatchObject({
      nativeSandbox: {
        passed: true,
        inputSha256: "a".repeat(64),
        system: "25G83",
        runtime: "0.0.78",
      },
      realAccount: { passed: false },
    });
    choose(f);
    m.status.mockResolvedValueOnce({
      available: true,
      state: "signed_out",
      codexVersion: "0.154.0",
    });
    await expect(f.agent.runner.start(f.cellId, "Fixture task")).rejects.toMatchObject({
      status: 400,
      message: "ChatGPT plan: sign in under Settings first.",
    });
    expect(recordOf(f).realAccount).toEqual({ passed: false });
    m.status.mockResolvedValue(signedIn);
    expect((await f.agent.runner.start(f.cellId, "Fixture task")).task).toBe("Fixture task");
    expect(recordOf(f).realAccount).toMatchObject({ passed: true });
  });
  it("keeps tasks closed when this Mac's sandbox check fails", async () => {
    Object.assign(m.record, released());
    m.installed = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.check.mockRejectedValue(new NativeCheckError("task nested"));
    const f = setup();
    await f.agent.start();
    const plan = f.agent.routes.chatgpt?.setup;
    await vi.waitFor(() => expect(plan?.sandbox()).toBe("failed"));
    expect(m.owner?.sandboxReason?.()).toBe(SANDBOX_REASONS.failed);
    choose(f);
    m.status.mockResolvedValue(signedIn);
    await expect(f.agent.runner.start(f.cellId, "Fixture task")).rejects.toMatchObject({
      status: 400,
      message: "ChatGPT support didn't pass its safety check on this Mac, so it stays off.",
    });
    expect(m.status).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    expect(() => readFileSync(join(f.home, "codex", "acceptance.json"))).toThrow();
  });
  it("checks again after a macOS update and keeps the user's account stamp", async () => {
    Object.assign(m.record, released());
    m.installed = true;
    const old = { system: "25F70", runtime: m.host.runtime };
    const f = setup({
      record: stampAccount(stampNative(undefined, old, "d".repeat(64), 1), old, 2),
    });
    await f.agent.start();
    const plan = f.agent.routes.chatgpt?.setup;
    await vi.waitFor(() => expect(plan?.sandbox()).toBe("passed"));
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(recordOf(f)).toMatchObject({
      nativeSandbox: { passed: true, system: "25G83" },
      realAccount: { passed: true, checkedAt: 2 },
    });
  });
  it("checks again after a release changes localDot's sandbox sources and keeps the account stamp", async () => {
    Object.assign(m.record, released());
    m.installed = true;
    const record = stampAccount(stampNative(undefined, m.host, "d".repeat(64), 1), m.host, 2);
    Object.assign(m.record, {
      nativeSandbox: { ...released().nativeSandbox, inputSha256: "e".repeat(64) },
    });
    const f = setup({ record });
    expect(m.owner?.sandboxReason?.()).toBe(SANDBOX_REASONS.unchecked);
    await f.agent.start();
    const plan = f.agent.routes.chatgpt?.setup;
    await vi.waitFor(() => expect(plan?.sandbox()).toBe("passed"));
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(recordOf(f)).toMatchObject({
      nativeSandbox: { passed: true, inputSha256: "e".repeat(64) },
      realAccount: { passed: true, checkedAt: 2 },
    });
  });
  it.each([false, true])(
    "does not construct a launcher for absent or unsafe roots: unsafe=%s",
    async (unsafe) => {
      const f = setup(unsafe ? { unsafe: true } : { codex: false });
      expect(m.owner).toBeUndefined();
      expect(m.driver).toBeUndefined();
      expect(f.agent.routes.chatgpt).toBeUndefined();
      await f.agent.start();
      expect(m.verify).not.toHaveBeenCalled();
      expect(m.ensure).not.toHaveBeenCalled();
      expect(f.agent.routes.harness?.()).toEqual(
        unsafe
          ? { available: false, reason: "The ChatGPT storage could not be validated." }
          : pending,
      );
    },
  );
  it("keeps unsupported-platform capability separate from installer state", () => {
    m.available = { available: false, reason: "fixture unsupported platform" };
    m.installed = true;
    const f = setup();
    expect(f.agent.routes.harness?.()).toEqual(m.available);
    expect(f.agent.routes.chatgpt?.availability()).toEqual(m.available);
  });
  it("notifies idle and paused ChatGPT sessions as well as running ones", () => {
    const f = setup(),
      ids = new Set<string>();
    for (const state of ["running", "paused", "idle"] as const) {
      const s = f.session();
      s.setStatus(state);
      ids.add(s.id);
    }
    const api = f.session();
    api.setStatus("running");
    vi.spyOn(f.agent.runner, "isChatgpt").mockImplementation((id) => ids.has(id));
    expect(
      required(m.owner)
        .sessions()
        .map((s) => s.id),
    ).toEqual([...ids]);
    const snapshot = ["/Volumes/Private"];
    vi.spyOn(f.agent.runner, "codexDenyReadOf").mockReturnValue(snapshot);
    expect(required(m.owner).taskDenyRead?.([...ids][0] ?? "")).toBe(snapshot);
  });
  it("sends MCP and API tool calls through the same policy and tool dependencies", async () => {
    const f = setup();
    await f.agent.start();
    const s = f.session(),
      generation = s.beginBrain(),
      signal = generation.signal,
      d = required(m.driver);
    await d.openEndpoint({
      session: s,
      generation,
      authGeneration: 1,
      currentAuthGeneration: () => 1,
      authSignal: signal,
      signal,
    });
    s.toolToken = "t".repeat(43);
    const endpoint = required(m.endpoints[0]),
      callId = ulid();
    const context = {
      generation,
      authGeneration: 1,
      turnEpoch: {} as never,
      basisFrameId: f.frameId,
      connection: {},
      requestId: 1,
      signal,
    };
    const mcp = await endpoint.dispatch("shell", callId, { command: "pwd" }, context);
    expect(mcp.result.ok).toBe(false);
    const response = await required(m.toolApp).request("/v1/tools/shell", {
      method: "POST",
      headers: { authorization: `Bearer ${s.toolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ callId: ulid(), input: { command: "pwd" } }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
    expect(f.policy.decide).toHaveBeenCalledTimes(2);
    const [first, second] = m.dispatch.mock.calls;
    expect(first?.[0].tools).toBe(required(m.tool).tools);
    expect(second?.[0].tools).toBe(required(m.tool).tools);
    expect(first?.[0].policy).toBe(f.policy);
    expect(second?.[0].policy).toBe(f.policy);
  });
  it.each([
    ["paused", { paused: true }],
    ["fenced", { fenced: { revision: 1 } }],
    ["waiting on its replacement", { replacementPending: true }],
    ["not ready", { state: "stopping" }],
    ["held by the kill switch", {}],
  ] as const)("gives secret typing no device while the computer is %s", async (name, patch) => {
    const f = setup();
    const device = { client: {} } as unknown as NonNullable<
      ReturnType<AgentWiringDeps["registry"]["for"]>
    >;
    f.deps.registry.for = () => device;
    const tools = required(m.tool).tools;
    expect(tools.device?.(f.cellId)).toBeUndefined();
    await f.agent.start();
    expect(tools.device?.(f.cellId)).toBe(device);
    if (name === "held by the kill switch") f.state.busy = true;
    else f.change(patch);
    expect(tools.device?.(f.cellId)).toBeUndefined();
  });
  it("supplies a full-frame PNG and records provenance only after all checks", async () => {
    const f = setup();
    await f.agent.start();
    const s = f.session(),
      g = s.beginBrain();
    const result = await required(m.driver).observe(s, g, g.signal);
    expect(result).toEqual({
      frameId: f.frameId,
      full: true,
      png: await m.png.mock.results[0]?.value,
    });
    expect(m.png).toHaveBeenCalledExactlyOnceWith(
      s.id,
      f.frameId,
      undefined,
      expect.any(AbortSignal),
    );
    expect(s.lastFrameId).toBe(f.frameId);
    expect(s.tainted).toBe(true);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith({
      sessionId: s.id,
      cellId: s.cellId,
      signal: expect.any(AbortSignal),
    });
  });
  it("taints the task with the screen a ChatGPT turn starts on, when the user is signed in there", async () => {
    const f = setup();
    f.deps.sessionScreens = {
      install: vi.fn(),
      manual: vi.fn(),
      bind: vi.fn(() => ({ cellId: f.cellId })),
      startBrowser: vi.fn(async () => {}),
    } as unknown as AgentWiringDeps["sessionScreens"];
    await f.agent.start();
    const observeOn = async (screen: ScreenName) => {
      const s = f.session();
      s.attachScreens({
        activate: async () => ({}),
        lease: (scope: ScreenScope) => ({
          selection: { screen, cellId: f.cellId, geometry: null, revision: 1 },
          signal: scope.signal,
          check: () => scope.check(),
          finish() {},
        }),
        takeOver: async () => {},
        close: async () => {},
      } as unknown as ScreenController);
      const g = s.beginBrain();
      await s.prepareScreens(g);
      await required(m.driver).observe(s, g, g.signal);
      return s;
    };
    const browser = await observeOn("browser");
    expect(
      f.log
        .read(browser.id)
        .filter((event) => event.type === "safety.taint")
        .map((event) => event.data),
    ).toEqual([{ kind: "screen", origin: "browser screen" }]);
    expect((await observeOn("desktop")).taint.tainted).toBe(false);
  });
  it.each(["endpoint", "generation", "control", "keyd", "busy", "pause"])(
    "rejects a capture when %s changes while the gateway is pending",
    async (change) => {
      const f = setup();
      await f.agent.start();
      const s = f.session(),
        g = s.beginBrain(),
        captured = gate<{ frameId: string }>();
      f.observe.mockReturnValueOnce(captured.promise);
      const work = required(m.driver).observe(s, g, g.signal);
      const failed = expect(work).rejects.toThrow();
      if (change === "endpoint") f.rotate();
      else if (change === "generation") s.retireBrain(g);
      else if (change === "control") {
        const held = s.takeover("login", "Fixture login");
        void held.catch(() => {});
      } else if (change === "keyd") f.state.online = false;
      else if (change === "busy") f.state.busy = true;
      else f.change({ paused: true });
      captured.resolve({ frameId: f.frameId });
      await failed;
      expect(m.png).not.toHaveBeenCalled();
      expect(s.lastFrameId).toBeUndefined();
      expect(s.tainted).toBe(false);
    },
  );
  it("checks endpoint ownership again after PNG conversion", async () => {
    const f = setup();
    await f.agent.start();
    const s = f.session(),
      g = s.beginBrain(),
      png = gate<Buffer>();
    m.png.mockImplementationOnce(() => {
      f.rotate();
      return png.promise;
    });
    const work = required(m.driver).observe(s, g, g.signal);
    const failed = expect(work).rejects.toThrow();
    await new Promise<void>((r) => setImmediate(r));
    png.resolve(Buffer.from("fixture"));
    await failed;
    expect(s.lastFrameId).toBeUndefined();
    expect(s.tainted).toBe(false);
  });
  it("blocks observation before successful startup", async () => {
    const f = setup(),
      s = f.session(),
      g = s.beginBrain();
    await expect(required(m.driver).observe(s, g, g.signal)).rejects.toThrow();
    expect(f.observe).not.toHaveBeenCalled();
    expect(m.png).not.toHaveBeenCalled();
  });
  it("uses the runner's auth Resume cursor", async () => {
    const f = setup(),
      s = f.session();
    const wait = vi.spyOn(f.agent.runner, "waitForAuthResume").mockResolvedValue();
    await required(m.driver).waitForAuthResume?.(s);
    expect(wait).toHaveBeenCalledExactlyOnceWith(s);
  });
});

describe("Claude Code production integration", () => {
  it("taints a Claude Code task as a ChatGPT one: its memory, its first screen and every call", async () => {
    const f = setup({ claude: true });
    f.deps.sessionScreens = {
      install: vi.fn(),
      manual: vi.fn(),
      bind: vi.fn(() => ({ cellId: f.cellId })),
      startBrowser: vi.fn(async () => {}),
    } as unknown as AgentWiringDeps["sessionScreens"];
    await f.agent.start();
    const claude = required(m.claude);
    expect(claude.observe).toBe(required(m.driver).observe);
    new MemoryStore(f.home).apply(ulid(), "MEMORY.md", "append", "Account 4417-1234-5678");
    const s = f.session();
    s.recent = [{ title: "Pay the <gas> bill", outcome: "done", day: "2026-10-08" }];
    const prompt = claude.instructions(s);
    expect(prompt).toContain(CHECK_MEMORY_FIRST);
    expect(prompt).toContain("Account 4417-1234-5678");
    expect(prompt).toContain("Pay the &lt;gas&gt; bill");
    expect(s.taint.overlap("my account 4417-1234-5678").overlaps).toBe(true);

    s.attachScreens({
      activate: async () => ({}),
      lease: (scope: ScreenScope) => ({
        selection: { screen: "browser", cellId: f.cellId, geometry: null, revision: 1 },
        signal: scope.signal,
        check: () => scope.check(),
        finish() {},
      }),
      takeOver: async () => {},
      close: async () => {},
    } as unknown as ScreenController);
    const g = s.beginBrain();
    await s.prepareScreens(g);
    await claude.observe(s, g, g.signal);
    expect(
      f.log
        .read(s.id)
        .filter((event) => event.type === "safety.taint")
        .map((event) => event.data),
    ).toEqual([
      { kind: "memory", origin: "MEMORY.md" },
      { kind: "screen", origin: "browser screen" },
    ]);

    const remembered = await claude.dispatch(
      s,
      g,
      "remember",
      ulid(),
      { file: "MEMORY.md", op: "append", text: "Account 4417-1234-5678" },
      g.signal,
    );
    expect(remembered.ok).toBe(false);
    expect(m.dispatch).toHaveBeenCalledOnce();
    expect(f.policy.decide).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: s.id, tool: "remember", tainted: true }),
    );
  });
});

describe("ChatGPT shutdown ownership", () => {
  it("registers auth close and install cancellation before awaits, drains tracked work, and leaves unrelated owned files", async () => {
    const f = setup();
    await f.agent.start();
    const installing = gate<never>(),
      closing = gate<void>();
    m.ensure.mockReturnValueOnce(installing.promise);
    m.authClose.mockReturnValueOnce(closing.promise);
    const sentinel = join(required(m.owner).roots.workRoot, "unrelated-sentinel");
    writeFileSync(sentinel, "keep", { mode: 0o600 });
    const work = required(f.agent.routes.chatgpt).installer.ensureInstalled(
      new AbortController().signal,
    );
    void work.catch(() => {});
    let closed = false;
    const close = f.agent.close().then(() => {
      closed = true;
    });
    expect(m.cancel).toHaveBeenCalledTimes(1);
    expect(m.authClose).toHaveBeenCalledTimes(1);
    await new Promise<void>((r) => setImmediate(r));
    expect(closed).toBe(false);
    // Confirm the installer has its own drain barrier after auth ownership settles.
    closing.resolve();
    await new Promise<void>((r) => setImmediate(r));
    const beforeInstallSettles = closed;
    installing.resolve(undefined as never);
    await close;
    await work;
    expect(beforeInstallSettles).toBe(false);
    expect(closed).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    await expect(
      required(f.agent.routes.chatgpt).installer.ensureInstalled(new AbortController().signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(m.ensure).toHaveBeenCalledTimes(1);
  });
  it("treats canceled installation as expected shutdown but exposes uncertain auth cleanup", async () => {
    const f = setup();
    await f.agent.start();
    m.ensure.mockRejectedValueOnce(new CodexInstallError("cancelled"));
    const work = required(f.agent.routes.chatgpt).installer.ensureInstalled(
      new AbortController().signal,
    );
    void work.catch(() => {});
    m.authClose.mockRejectedValueOnce(new Error("fixture ownership uncertain"));
    await expect(f.agent.close()).rejects.toThrow("cleanup could not be confirmed");
    await expect(work).rejects.toMatchObject({ code: "cancelled" });
  });
  it("retains ownership of startup verification during shutdown", async () => {
    const verifying = gate<undefined>();
    m.verify.mockReturnValueOnce(verifying.promise);
    const f = setup(),
      start = f.agent.start();
    void start.catch(() => {});
    await new Promise<void>((r) => setImmediate(r));
    expect(m.verify).toHaveBeenCalledTimes(1);
    let closed = false;
    const close = f.agent.close().then(() => {
      closed = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(closed).toBe(false);
    expect(m.serve).not.toHaveBeenCalled();
    verifying.resolve(undefined);
    await expect(start).rejects.toThrow("closed");
    await close;
    expect(closed).toBe(true);
    expect(m.serve).not.toHaveBeenCalled();
  });
});

it("connects synchronous auth pause to the actual runner independently of journals", () => {
  const f = setup(),
    s = f.session();
  const pause = vi.spyOn(f.agent.runner, "pauseForAuth");
  required(m.owner).pauseForAuth?.(s, 7);
  expect(pause).toHaveBeenCalledExactlyOnceWith(s, 7);
});
