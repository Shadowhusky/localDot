import { mkdtempSync, rmSync } from "node:fs";
import { type BootConfig, type KeydRecord, type TaskPricing, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { KeydHealth } from "../keyd/monitor.ts";
import type { BrainCell, OpenBrain } from "./brain-cell.ts";
import { MemoryStore } from "./memory.ts";
import { AgentRunner, type AgentRunnerDeps } from "./runner.ts";
import type { AgentSettings } from "./settings.ts";
import { TranscriptStore } from "./transcript.ts";
import { Transfers } from "./transfers.ts";

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
  const home = mkdtempSync("/tmp/ld-runner-");
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

it("keeps the live owner after brain cleanup fails until the admitted tool settles", async () => {
  const h = setup();
  const session = await h.runner.start(h.cellId, "Task");
  await h.ready();
  const lease = session.admit(required(session.generation));
  try {
    h.state.failClose = true;
    h.exit(0, 1);
    await until(() => h.containments.length === 1);
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.state.paused).toBe(true);
    expect(session.stopped).toBe(true);
    expect(h.live.get(h.cellId)).toBe(session.id);
    expect(h.runner.get(session.id)).toBe(session);
  } finally {
    lease.finish();
    await h.live.settled(session.id);
  }
});

it("an idle upload already registered before followup blocks a replacement until release", async () => {
  const h = setup();
  const transfers = new Transfers();
  h.deps.waitForUploads = (id, signal) => transfers.wait(id, signal);
  const session = await h.runner.start(h.cellId, "Task");
  await h.ready();
  h.exit(0, 0);
  await until(() => session.status === "idle");
  const lease = transfers.acquire(h.cellId, [session.abort.signal], () => {});
  session.post("followup", "Continue");
  try {
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.opens).toHaveLength(1);
  } finally {
    lease.release();
    await h.ready(2);
  }
});
