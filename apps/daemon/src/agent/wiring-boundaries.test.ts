import { mkdtempSync, rmSync } from "node:fs";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CellRecord, type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { BrainCellsDeps } from "./brain-cell.ts";
import { AgentSession } from "./session.ts";
import { type AgentWiringDeps, createAgent } from "./wiring.ts";

type ClientFixture = { endpoint: { baseUrl: string; token: string }; closed: boolean };
const mocks = vi.hoisted(() => ({
  clients: [] as ClientFixture[],
  brainDeps: undefined as BrainCellsDeps | undefined,
  sweep: vi.fn(async () => 0),
}));
vi.mock("../desktopd/tools-client.ts", () => ({
  DesktopdTools: class {
    closed = false;
    constructor(readonly endpoint: { baseUrl: string; token: string }) {
      mocks.clients.push(this);
    }
    async close() {
      this.closed = true;
    }
    async putFile(
      path: string,
      source: ReadableStream<Uint8Array>,
      _mode?: number,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      await new Response(source).arrayBuffer();
      signal?.throwIfAborted();
      return `~/${path}`;
    }
  },
}));
vi.mock("./brain-cell.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./brain-cell.ts")>();
  return {
    ...original,
    BrainCells: class {
      constructor(deps: BrainCellsDeps) {
        mocks.brainDeps = deps;
      }
      sweep() {
        return mocks.sweep();
      }
      reservedPorts() {
        return [4796];
      }
    },
  };
});
const fixtures: { agent: ReturnType<typeof createAgent>; log: EventLog; home: string }[] = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) {
    await h.agent.close();
    h.log.close();
    rmSync(h.home, { recursive: true, force: true });
  }
  mocks.clients.length = 0;
  mocks.sweep.mockReset();
  mocks.sweep.mockResolvedValue(0);
});
function required<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("fixture missing value");
  return x;
}
function setup() {
  const home = mkdtempSync("/tmp/ld-agent-wiring-"),
    log = new EventLog(home),
    live = new LiveSessions(),
    cellId = ulid();
  let cell: CellSummary = {
    id: cellId,
    state: "ready",
    scale: 1,
    createdAt: new Date().toISOString(),
    stream: NO_STREAM,
  };
  let endpoint = { baseUrl: "http://127.0.0.1:1", token: "d".repeat(43) };
  let busy = false;
  const listeners = new Set<(cell: CellSummary) => void>();
  const deps: AgentWiringDeps = {
    home,
    installToken: "i".repeat(43),
    eventLog: log,
    live,
    cells: {
      get: () => cell,
      list: () => [cell],
      record: () =>
        ({
          id: cellId,
          keydPort: 4791,
          tokens: { desktopd: endpoint.token, stream: "s".repeat(43) },
        }) as CellRecord,
      endpoints: () =>
        cell.state === "ready" && !cell.paused
          ? {
              desktopd: endpoint,
              stream: { baseUrl: "http://127.0.0.1:2", authorization: "fixture" },
            }
          : undefined,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      reservedKeydPorts: () => [4791, 4792],
    },
    registry: { for: () => undefined },
    gateway: {} as AgentWiringDeps["gateway"],
    frames: new FrameStore(home),
    docker: {} as AgentWiringDeps["docker"],
    keyd: {} as AgentWiringDeps["keyd"],
    monitor: { health: { online: true, bootId: "one" } },
    killSwitch: { isBusy: () => busy, stopSession: async () => undefined },
    keydPorts: { from: 4791, to: 4796 },
    toolPort: 0,
  };
  const agent = createAgent(deps);
  fixtures.push({ agent, log, home });
  return {
    agent,
    log,
    home,
    live,
    cellId,
    deps,
    setBusy: (value: boolean) => {
      busy = value;
    },
    change: (patch: Partial<CellSummary>, token?: string) => {
      cell = { ...cell, ...patch };
      if (token) endpoint = { ...endpoint, token };
      for (const listener of listeners) listener(cell);
    },
  };
}

describe("production agent ownership wiring", () => {
  it("blocks allocation before successful startup sweep and includes pending desktop ports", async () => {
    const h = setup();
    expect(() => h.agent.reservedPorts()).toThrow("cleanup");
    expect([...required(mocks.brainDeps).desktopPorts()]).toEqual([4791, 4792]);
    await h.agent.start();
    expect([...h.agent.reservedPorts()]).toEqual([4796]);
  });
  it("keeps allocation blocked after uncertain startup cleanup", async () => {
    mocks.sweep.mockRejectedValueOnce(new Error("fixture cleanup uncertainty"));
    const h = setup();
    await expect(h.agent.start()).rejects.toThrow();
    expect(() => h.agent.reservedPorts()).toThrow();
  });
  it("reuses an endpoint client and cancels admitted uploads when the cell pauses or rotates", async () => {
    const h = setup();
    await h.agent.start();
    const first = required(h.agent.routes.desktop(h.cellId, new AbortController().signal));
    const second = required(h.agent.routes.desktop(h.cellId, new AbortController().signal));
    expect(mocks.clients).toHaveLength(1);
    h.change({ paused: true });
    expect(first.signal.aborted).toBe(true);
    expect(() => second.check()).toThrow();
    expect(mocks.clients[0]?.closed).toBe(true);
    first.release();
    second.release();
    h.change({ paused: undefined }, "n".repeat(43));
    const next = required(h.agent.routes.desktop(h.cellId, new AbortController().signal));
    expect(mocks.clients).toHaveLength(2);
    expect(next.signal.aborted).toBe(false);
    next.release();
  });
  it("joins active uploads to the takeover drain and blocks new uploads while control is held", async () => {
    const h = setup();
    await h.agent.start();
    const id = h.log.createSession("task"),
      session = new AgentSession(id, h.cellId, "task", h.log);
    session.beginBrain();
    session.status = "running";
    let finish!: () => void;
    h.live.start(
      h.cellId,
      id,
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    h.agent.runner.sessions.set(id, session);
    const upload = required(h.agent.routes.desktop(h.cellId, new AbortController().signal));
    const lease = session.admit(required(session.generation));
    const held = session.takeover("login", "Sign in", undefined, lease);
    expect(upload.signal.aborted).toBe(true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.log.read(id).some((e) => e.type === "takeover.request")).toBe(false);
    expect(() => h.agent.routes.desktop(h.cellId, new AbortController().signal)).toThrow();
    upload.release();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.log.read(id).filter((e) => e.type === "takeover.request")).toHaveLength(1);
    session.endTakeover(required(session.pendingTakeover), undefined);
    await held;
    lease.finish();
    h.agent.runner.sessions.delete(id);
    session.stop();
    finish();
    await h.live.settled(id);
  });
  it("redacts daemon and current cell credentials before user text is persisted", async () => {
    const h = setup();
    await h.agent.start();
    expect(
      h.agent.routes.redactUserText(
        `${h.deps.installToken} ${"d".repeat(43)} hello`,
        undefined,
        h.cellId,
      ),
    ).toBe("[redacted] [redacted] hello");
    h.setBusy(true);
    expect(() => h.agent.routes.desktop(h.cellId, new AbortController().signal)).toThrow();
  });
});

it("retains shutdown ownership of an in-flight startup sweep", async () => {
  let release!: () => void;
  mocks.sweep.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        release = () => resolve(0);
      }),
  );
  const h = setup();
  const start = h.agent.start();
  const rejected = expect(start).rejects.toThrow("closed");
  let closed = false;
  const closing = h.agent.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  release();
  await rejected;
  await closing;
  expect(() => h.agent.reservedPorts()).toThrow();
});

it("shutdown aborts an idle upload but waits until its transport really settles", async () => {
  const h = setup();
  await h.agent.start();
  const upload = required(h.agent.routes.desktop(h.cellId, new AbortController().signal));
  let closed = false;
  const closing = h.agent.close().then(() => {
    closed = true;
  });
  expect(upload.signal.aborted).toBe(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  upload.release();
  await closing;
  expect(closed).toBe(true);
});
