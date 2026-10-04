import { mkdtempSync, rmSync } from "node:fs";
import { type BootConfig, type KeydRecord, type TaskPricing, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { KeydHealth } from "../keyd/monitor.ts";
import type { BrainCell, OpenBrain } from "./brain-cell.ts";
import { MemoryStore } from "./memory.ts";
import { agentRoutes } from "./routes.ts";
import { AgentRunner, type AgentRunnerDeps } from "./runner.ts";
import type { AgentSettings } from "./settings.ts";
import { SettingsStore } from "./settings.ts";
import { TranscriptStore } from "./transcript.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing value");
  return value;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("fixture never reached state");
}
const fixtures: { runner: AgentRunner; log: EventLog; home: string }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of fixtures.splice(0)) {
    await h.runner.close();
    h.log.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});
function setup(options: { settings?: AgentSettings } = {}) {
  const home = mkdtempSync("/tmp/localdot-task11-review-terminal-");
  const log = new EventLog(home);
  const live = new LiveSessions();
  const cellId = ulid(),
    at = "2026-10-02T00:00:00Z";
  const keys: KeydRecord[] = [
    { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: at, updatedAt: at },
  ];
  let settings: AgentSettings = options.settings ?? {
    main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
    taskBudgetUSD: 5,
  };
  const opens: OpenBrain[] = [],
    starts: BrainCell[] = [],
    closed: string[] = [],
    boots: BootConfig[] = [],
    raiseCalls: string[] = [],
    containments: string[] = [];
  const exits = new Map<string, (code: number) => void>();
  const ledger = new Map<string, { limit: number; spent: number; pricing: TaskPricing }>();
  const state: {
    paused?: true;
    busy: boolean;
    health: KeydHealth;
    openGate?: Promise<void>;
    startGate?: Promise<void>;
    raiseGate?: Promise<void>;
    skillsGate?: Promise<void>;
    secretsGate?: Promise<void>;
    failOpen?: "before" | "after";
    failClose?: boolean;
  } = { busy: false, health: { online: true, bootId: "boot-a" } };
  const brains = {
    open: async (o: OpenBrain): Promise<BrainCell> => {
      opens.push({ ...o, pricing: structuredClone(o.pricing) });
      if (state.openGate) await state.openGate;
      if (state.failOpen === "before") {
        state.failOpen = undefined;
        throw new Error("fixture pre-commit failure");
      }
      if (!ledger.has(o.sessionId))
        ledger.set(o.sessionId, {
          limit: o.budgetUSD ?? 1,
          spent: 0,
          pricing: structuredClone(o.pricing),
        });
      if (state.failOpen === "after") {
        state.failOpen = undefined;
        throw new Error("fixture committed lost reply");
      }
      const id = ulid();
      return {
        id,
        sessionId: o.sessionId,
        keydPort: 4791,
        home: "test",
        names: { internalNetwork: "i", egressNetwork: "e", gate: "g", brain: "b" },
        gateInternalIp: "172.30.4.10",
        gateEgressIp: "172.30.5.10",
        brainIp: "172.30.4.11",
        proxyUrl: "http://172.30.4.10:3128",
        proxyToken: `p${opens.length}`.padEnd(43, "p"),
        toolToken: `t${opens.length}`.padEnd(43, "t"),
        surrogates: { anthropic: `ld_llm_${String(opens.length).padStart(22, "0")}_abcdef` },
      };
    },
    start: async (brain: BrainCell) => {
      starts.push(brain);
      boots.push(structuredClone(required(runner.get(brain.sessionId)?.boot)));
      if (state.startGate) await state.startGate;
    },
    exited: async (brain: BrainCell, signal: AbortSignal) =>
      new Promise<number | undefined>((resolve) => {
        const done = (code: number | undefined) => {
          exits.delete(brain.id);
          signal.removeEventListener("abort", abort);
          resolve(code);
        };
        const abort = () => done(undefined);
        exits.set(brain.id, (code) => done(code));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    close: async (brain: BrainCell) => {
      closed.push(brain.id);
      if (state.failClose) throw new Error("fixture uncertain cleanup");
    },
  };
  const deps: AgentRunnerDeps = {
    eventLog: log,
    live,
    cell: (id) =>
      id === cellId
        ? {
            id,
            state: "ready",
            scale: 2,
            createdAt: at,
            stream: NO_STREAM,
            ...(state.paused ? { paused: state.paused } : {}),
          }
        : undefined,
    cellBusy: () => state.busy,
    brains,
    keyd: {
      secrets: async () => {
        if (state.secretsGate) await state.secretsGate;
        return keys;
      },
      beginTask: async (brain, id, usd) => {
        raiseCalls.push(brain);
        if (state.raiseGate) await state.raiseGate;
        required(ledger.get(id)).limit = required(usd);
      },
    },
    keydHealth: () => state.health,
    settings: () => settings,
    catalog: () => normalizeCatalog(MODELS_DEV_FIXTURE, at),
    memory: new MemoryStore(home),
    transcripts: new TranscriptStore(home),
    installSkills: async (_id, signal) => {
      if (state.skillsGate) await state.skillsGate;
      signal.throwIfAborted();
      return [];
    },
    waitForUploads: async () => {},
    stopSession: async (id) => {
      containments.push(id);
      live.stop(id);
      state.paused = true;
      return { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
    },
    sleep: async () => {},
    idleMs: 60_000,
  };
  const runner = new AgentRunner(deps);
  const h = {
    home,
    log,
    live,
    cellId,
    runner,
    brains,
    state,
    opens,
    starts,
    boots,
    closed,
    exits,
    ledger,
    raiseCalls,
    containments,
    deps,
    setSettings: (value: AgentSettings) => {
      settings = value;
    },
    ready: async (n = 1) => {
      await until(() => starts.length >= n && exits.has(required(starts[n - 1]).id));
      return required(starts[n - 1]);
    },
    exit: (n = 0, code = 0) => required(exits.get(required(starts[n]).id))(code),
    health: async (now: KeydHealth) => {
      const before = state.health;
      state.health = now;
      await runner.keydChanged(now, before);
    },
  };
  fixtures.push(h);
  return h;
}

// Independent cross-layer observation: the real runner, real route and durable MemoryStore.
// Worker, keyd and desktop boundaries stay inert; no listener/account/model is used.
it("keeps an ended real task readable for the terminal-memory action authority", async () => {
  const h = setup();
  h.deps.idleMs = 1;
  const memory = new MemoryStore(h.home);
  const app = new Hono();
  agentRoutes(app, {
    home: h.home,
    runner: h.runner,
    memory,
    settings: new SettingsStore(h.home),
    catalog: { get: h.deps.catalog, refresh: async () => h.deps.catalog()! },
    keyd: { secrets: async () => [] },
    skills: () => [],
    desktop: () => {
      throw new Error("unexpected desktop access");
    },
    redactUserText: (text) => text,
    appendTo: (id, type, data) => {
      h.log.append(id, { agent: "main", type, data } as never);
    },
    canChangeMemory: () => true,
  });
  const session = await h.runner.start(h.cellId, "Keep this memory change available");
  await h.ready();
  const change = memory.apply(session.id, "MEMORY.md", "append", "Retained fixture fact");
  session.append("memory.change", {
    file: change.file,
    changeId: change.changeId,
    patch: change.patch,
  });
  const path = `/api/agent/sessions/${session.id}`;
  expect((await app.request(path)).status, "positive live snapshot").toBe(200);
  h.exit();
  await until(() => h.runner.get(session.id) === undefined);
  expect(h.log.read(session.id).at(-1)?.type).toBe("session.end");
  // Durable history remains readable and undo is still valid after runtime retirement.
  const undo = await app.request(`/api/agent/memory/${change.changeId}/undo`, { method: "POST" });
  expect(undo.status, "positive real durable Undo after runtime retirement").toBe(200);
  expect(memory.readBoth().memory).not.toContain("Retained fixture fact");
  const response = await app.request(path);
  expect(response.status, "real retirement keeps bounded read-only terminal authority").toBe(200);
  const terminal = await response.json();
  const publicModels = {
    kind: "api",
    roles: [{ role: "main", provider: "anthropic", model: "claude-sonnet-5-5" }],
  };
  expect(terminal).toEqual({
    sessionId: session.id,
    cellId: h.cellId,
    status: "ended",
    toolCalls: 0,
    models: publicModels,
  });
  expect(h.runner.get(session.id)).toBeUndefined();
  expect(h.runner.selectionOf(session.id)).toBeUndefined();
  const snapshot = required(h.runner.terminalOf(session.id));
  Reflect.deleteProperty(snapshot, "models");
  expect(h.runner.terminalOf(session.id)?.models).toEqual(publicModels);
  for (const action of [
    "resume",
    "budget",
    "messages",
    "answer",
    "takeover/input",
    "takeover/done",
  ]) {
    const denied = await app.request(`${path}/${action}`, { method: "POST" });
    expect(denied.status, `terminal read must not restore ${action} authority`).toBe(404);
  }
  expect((await app.request(`/api/agent/sessions/${ulid()}`)).status).toBe(404);
  expect(h.runner.terminalOf(ulid())).toBeUndefined();
});

it("does not grant terminal read authority when recording the end event fails", async () => {
  const h = setup();
  h.deps.idleMs = 0;
  const append = h.log.append.bind(h.log);
  vi.spyOn(h.log, "append").mockImplementation((id, event) => {
    if (event.type === "session.end") throw new Error("inert journal refusal");
    return append(id, event);
  });
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const session = await h.runner.start(h.cellId, "Journal refused terminal authority");
  await h.ready();
  h.exit();
  await until(() => h.runner.get(session.id) === undefined);
  expect(h.runner.terminalOf(session.id)).toBeUndefined();
  expect(h.log.read(session.id).some((event) => event.type === "session.end")).toBe(false);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  diagnostic.mockRestore();
});
it("bounds daemon-lifetime terminal history and preserves the newest exact owner", async () => {
  const h = setup();
  h.deps.idleMs = 0;
  let first = "",
    last = "";
  for (let n = 0; n < 257; n++) {
    const session = await h.runner.start(h.cellId, `Inert terminal owner ${n}`);
    if (!n) first = session.id;
    last = session.id;
    await h.ready(n + 1);
    h.exit(n);
    await h.live.settled(session.id);
    expect(h.runner.get(session.id)).toBeUndefined();
  }
  expect(h.runner.terminalOf(first)).toBeUndefined();
  expect(h.runner.terminalOf(last)).toMatchObject({
    sessionId: last,
    cellId: h.cellId,
    status: "ended",
  });
});
