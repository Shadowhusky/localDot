import { mkdtempSync, rmSync } from "node:fs";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CellRecord, type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { BrainCell, BrainCellsDeps, OpenBrain } from "./brain-cell.ts";
import type { UploadAccess } from "./routes.ts";
import { ComputerFences } from "./safety/fences.ts";
import { AgentSession } from "./session.ts";
import { Transfers } from "./transfers.ts";
import { type AgentWiringDeps, createAgent } from "./wiring.ts";

type ClientFixture = { endpoint: { baseUrl: string; token: string }; closed: boolean };
const mocks = vi.hoisted(() => ({
  clients: [] as ClientFixture[],
  brainDeps: undefined as BrainCellsDeps | undefined,
  sweep: vi.fn(async () => 0),
  opens: [] as BrainCell[],
  exits: new Map<string, (code: number) => void>(),
  prepare: vi.fn(async (_taskId: string, _signal?: AbortSignal) => {}),
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
    async prepareBrowser(taskId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      await mocks.prepare(taskId, signal);
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
      async open(options: OpenBrain): Promise<BrainCell> {
        const brain: BrainCell = {
          id: ulid(),
          sessionId: options.sessionId,
          keydPort: 4796,
          home: "fixture",
          names: { internalNetwork: "i", egressNetwork: "e", gate: "g", brain: "b" },
          gateInternalIp: "172.30.4.10",
          gateEgressIp: "172.30.5.10",
          brainIp: "172.30.4.11",
          proxyUrl: "http://172.30.4.10:3128",
          proxyToken: "p".repeat(43),
          toolToken: "t".repeat(43),
          surrogates: {},
        };
        mocks.opens.push(brain);
        return brain;
      }
      async start() {}
      exited(brain: BrainCell, signal: AbortSignal): Promise<number | undefined> {
        return new Promise((resolve) => {
          const finish = (code: number | undefined) => {
            mocks.exits.delete(brain.id);
            signal.removeEventListener("abort", abort);
            resolve(code);
          };
          const abort = () => finish(undefined);
          mocks.exits.set(brain.id, (code) => finish(code));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      async close() {}
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
  mocks.opens.length = 0;
  mocks.exits.clear();
  mocks.sweep.mockReset();
  mocks.sweep.mockResolvedValue(0);
  mocks.prepare.mockReset();
  mocks.prepare.mockResolvedValue(undefined);
});
function required<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("fixture missing value");
  return x;
}
function setup(transfers?: Transfers) {
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
    transfers,
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

it("scripted preparation shares the upload drain and holds Stop through physical completion", async () => {
  const transfers = new Transfers();
  const h = setup(transfers);
  const fences = new ComputerFences(h.home);
  h.deps.fences = fences;
  await h.agent.start();
  const sessionId = h.log.createSession("scripted browser task");
  const upload = transfers.acquire(h.cellId, [], () => {});
  const physical = Promise.withResolvers<void>();
  mocks.prepare.mockImplementation(async () => physical.promise);
  const stop = vi.spyOn(h.deps.killSwitch, "stopSession").mockImplementation(async (id) => {
    h.live.stop(id);
    return { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
  });
  const beforeRun = vi.fn(async () => {});
  const run = vi.fn(async (signal: AbortSignal) => {
    expect(signal.aborted).toBe(true);
  });
  h.live.addHooks({ beforeRun });
  h.live.start(h.cellId, sessionId, run, (signal) =>
    h.agent.prepareDesktopTask(h.cellId, sessionId, signal),
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.prepare).not.toHaveBeenCalled();
    upload.release();
    await until(() => mocks.prepare.mock.calls.length === 1);
    expect(mocks.prepare).toHaveBeenCalledWith(sessionId, expect.any(AbortSignal));
    h.live.stop(sessionId);
    let drained = false;
    const draining = transfers.wait(h.cellId).then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(h.live.get(h.cellId)).toBe(sessionId);
    expect(run).not.toHaveBeenCalled();
    physical.resolve();
    await h.live.settled(sessionId);
    await draining;
    expect(beforeRun).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(sessionId);
    expect(fences.isFenced(h.cellId)).toBe(true);
  } finally {
    upload.release();
    physical.resolve();
    h.live.stop(sessionId);
    await h.live.settled(sessionId);
  }
});

it("lost scripted preparation replies fence the computer and cannot replay on another task", async () => {
  const h = setup();
  const fences = new ComputerFences(h.home);
  h.deps.fences = fences;
  await h.agent.start();
  mocks.prepare.mockRejectedValue(new Error("fixture reply lost"));
  const stop = vi.spyOn(h.deps.killSwitch, "stopSession").mockImplementation(async (id) => {
    h.live.stop(id);
    throw new Error("fixture containment reply lost");
  });
  const beforeRun = vi.fn(async () => {});
  h.live.addHooks({ beforeRun });
  for (const title of ["lost response", "attempted replacement"]) {
    const sessionId = h.log.createSession(title);
    const run = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(true);
    });
    h.live.start(h.cellId, sessionId, run, (signal) =>
      h.agent.prepareDesktopTask(h.cellId, sessionId, signal),
    );
    await h.live.settled(sessionId);
    expect(run).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(sessionId);
  }
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(beforeRun).not.toHaveBeenCalled();
  expect(fences.isFenced(h.cellId)).toBe(true);
  expect(new ComputerFences(h.home).isFenced(h.cellId)).toBe(true);
});

it("shutdown still contains every session and closes clients when Stop journal publication fails", async () => {
  const h = setup();
  await h.agent.start();
  const upload = required(h.agent.routes.desktop(h.cellId, new AbortController().signal));
  upload.release();
  const idA = h.log.createSession("task A"),
    idB = h.log.createSession("task B");
  const first = new AgentSession(idA, h.cellId, "A", h.log);
  const second = new AgentSession(idB, ulid(), "B", h.log);
  first.beginBrain();
  second.beginBrain();
  h.agent.runner.sessions.set(idA, first);
  h.agent.runner.sessions.set(idB, second);
  const held = first.takeover("login", "Sign in");
  const observed = held.catch(() => undefined);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(first.controlHeld).toBe(true);
  const originalAppend = h.log.append.bind(h.log);
  const append = vi.spyOn(h.log, "append").mockImplementation((id, event) => {
    if (event.type === "takeover.end") throw new Error("fixture disk failure");
    return originalAppend(id, event);
  });
  const stop = vi
    .spyOn(h.deps.killSwitch, "stopSession")
    .mockResolvedValue({ revoked: true, paused: true, closed: false, stopped: false, errors: [] });
  try {
    await Promise.resolve()
      .then(() => h.agent.close())
      .catch(() => undefined);
    await observed;
    expect(stop.mock.calls.map(([id]) => id)).toEqual([idA, idB]);
    expect(mocks.clients.every((client) => client.closed)).toBe(true);
    expect(second.stopped).toBe(true);
  } finally {
    append.mockRestore();
    h.agent.runner.sessions.clear();
    first.stop();
    second.stop();
  }
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("fixture never reached state");
}
it("real idle-upload admission cannot pass a completed drain and overlap the replacement brain", async () => {
  const h = setup();
  h.deps.keyd.secrets = async () => [];
  const gates = new Map<string, import("@localdot/protocol").ModelAdmissionSnapshot>();
  h.deps.keyd.modelAdmission = async (id) => {
    let gate = gates.get(id);
    if (!gate) {
      const owner = required(mocks.opens.find((b) => b.id === id));
      gate = {
        taskId: owner.sessionId,
        generationId: "a".repeat(32),
        epoch: 1,
        paused: true,
        active: 0,
        retired: false,
      };
      gates.set(id, gate);
    }
    return { ...gate };
  };
  h.deps.keyd.setModelAdmission = async (id, write) => {
    const gate = await h.deps.keyd.modelAdmission(id);
    if (
      gate.taskId !== write.taskId ||
      gate.generationId !== write.generationId ||
      (write.state === "open" && (!gate.paused || gate.epoch !== write.expectedEpoch))
    )
      throw new Error("stale fixture model owner");
    const next = { ...gate, epoch: gate.epoch + 1, paused: write.state === "paused" };
    gates.set(id, next);
    return { ...next };
  };
  h.deps.killSwitch.stopSession = async () => ({
    revoked: true,
    paused: true,
    closed: false,
    stopped: false,
    errors: [],
  });
  h.agent.routes.settings.put({ main: { provider: "lmstudio", model: "fixture-tools-model" } });
  await h.agent.start();
  const session = await h.agent.runner.start(h.cellId, "Task");
  await until(() => mocks.exits.size === 1);
  required(mocks.exits.get(required(mocks.opens[0]).id))(0);
  await until(() => session.status === "idle");
  let late: UploadAccess | undefined;
  let inject = true;
  let admittedWhileIdle = false;
  const originalWait = Transfers.prototype.wait;
  const wait = vi.spyOn(Transfers.prototype, "wait").mockImplementation(async function (
    this: Transfers,
    id,
    signal,
  ) {
    await originalWait.call(this, id, signal);
    if (inject) {
      inject = false;
      queueMicrotask(() => {
        admittedWhileIdle = session.status === "idle" && !session.generation;
        late = h.agent.routes.desktop(h.cellId, new AbortController().signal);
      });
    }
  });
  session.post("followup", "Continue");
  try {
    await until(() => late !== undefined);
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(admittedWhileIdle).toBe(true);
    expect(late?.signal.aborted).toBe(false);
    expect(mocks.opens).toHaveLength(1);
  } finally {
    late?.release();
    wait.mockRestore();
    await until(() => mocks.opens.length === 2);
  }
});
