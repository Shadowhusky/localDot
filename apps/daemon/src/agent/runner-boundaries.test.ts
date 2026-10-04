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

describe("serialized agent lifecycle", () => {
  it.each([false, true])(
    "refuses task admission during an idle desktop mutation (late=%s)",
    async (late) => {
      const h = setup();
      const preflight = deferred<void>();
      let starting: Promise<unknown> | undefined;
      if (late) {
        h.state.secretsGate = preflight.promise;
        starting = h.runner.start(h.cellId, "Task");
        await Promise.resolve();
      }
      const lease = required(h.live.admitIdleOperation(h.cellId));
      const denied = expect(starting ?? h.runner.start(h.cellId, "Task")).rejects.toMatchObject({
        status: 409,
      });
      preflight.resolve();
      await denied;
      expect(h.runner.sessions.size).toBe(0);
      expect(h.opens).toEqual([]);
      expect(h.live.get(h.cellId)).toBeUndefined();
      lease.release();
      const session = await h.runner.start(h.cellId, "Task after native settlement");
      await h.ready();
      expect(h.live.get(h.cellId)).toBe(session.id);
    },
  );
  it("freezes task roles, prices and original budget across crashes and follow-ups", async () => {
    const h = setup();
    const session = await h.runner.start(h.cellId, "Task");
    await h.ready();
    const account = required(h.ledger.get(session.id));
    account.spent = 4;
    h.setSettings({ main: { provider: "lmstudio", model: "different" }, taskBudgetUSD: 99 });
    await h.runner.raiseBudget(session.id, 8);
    h.exit(0, 1);
    await h.ready(2);
    expect(h.opens.map((o) => [o.sessionId, o.budgetUSD])).toEqual([
      [session.id, 5],
      [session.id, 5],
    ]);
    expect(h.opens[1]?.pricing).toEqual(h.opens[0]?.pricing);
    expect(account).toMatchObject({ limit: 8, spent: 4 });
    expect(h.boots[1]?.models.main.model).toBe("claude-sonnet-5-5");
    expect(h.closed).toEqual([h.starts[0]?.id]);
    h.exit(1, 0);
    await until(() => session.status === "idle");
    session.post("followup", "Also hotels");
    await h.ready(3);
    expect(h.boots[2]).toMatchObject({ resume: true, inboxAfter: 0 });
    expect(h.opens[2]?.budgetUSD).toBe(5);
  });
  it.each(["before", "after"] as const)(
    "retries original initialization after %s-commit open failure",
    async (where) => {
      const h = setup();
      h.state.failOpen = where;
      const session = await h.runner.start(h.cellId, "Task");
      await h.ready();
      expect(h.opens.map((o) => o.budgetUSD)).toEqual([5, 5]);
      expect(required(h.ledger.get(session.id)).limit).toBe(5);
      await h.runner.raiseBudget(session.id, 8);
      h.exit(0, 1);
      await h.ready(2);
      expect(required(h.ledger.get(session.id)).limit).toBe(8);
    },
  );
  it("rejects concurrent start and a cell paused during preflight", async () => {
    const h = setup();
    const gate = deferred<void>();
    h.state.secretsGate = gate.promise;
    const first = h.runner.start(h.cellId, "one");
    await expect(h.runner.start(h.cellId, "two")).rejects.toMatchObject({ status: 409 });
    h.state.paused = true;
    gate.resolve();
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(h.opens).toHaveLength(0);
  });
  it("does not start or publish a brain after Stop during ignored open cancellation", async () => {
    const h = setup();
    const gate = deferred<void>();
    h.state.openGate = gate.promise;
    const session = await h.runner.start(h.cellId, "Task");
    await until(() => h.opens.length === 1);
    h.live.stop(session.id);
    expect(session.generation).toBeUndefined();
    gate.resolve();
    await h.live.settled(session.id);
    expect(h.starts).toHaveLength(0);
    expect(h.closed).toHaveLength(1);
    expect(session.toolToken).toBeUndefined();
    expect(h.opens).toHaveLength(1);
  });
  it("does not open after Stop during skill installation", async () => {
    const h = setup();
    const gate = deferred<void>();
    h.state.skillsGate = gate.promise;
    const session = await h.runner.start(h.cellId, "Task");
    h.live.stop(session.id);
    gate.resolve();
    await h.live.settled(session.id);
    expect(h.opens).toHaveLength(0);
  });
  it("serializes a raise behind confirmed initialization and never resumes after Stop", async () => {
    const h = setup();
    const open = deferred<void>();
    h.state.openGate = open.promise;
    const session = await h.runner.start(h.cellId, "Task");
    await until(() => h.opens.length === 1);
    const raise = h.runner.raiseBudget(session.id, 8);
    await Promise.resolve();
    expect(h.raiseCalls).toHaveLength(0);
    open.resolve();
    await raise;
    await h.ready();
    expect(h.raiseCalls).toHaveLength(1);
    const gate = deferred<void>();
    h.state.raiseGate = gate.promise;
    const second = h.runner.raiseBudget(session.id, 9);
    const rejected = expect(second).rejects.toMatchObject({ status: 409 });
    await until(() => h.raiseCalls.length === 2);
    h.live.stop(session.id);
    gate.resolve();
    await rejected;
    await h.live.settled(session.id);
    expect(h.opens).toHaveLength(1);
  });
  it("keeps cleanup uncertainty fenced and invokes full containment even after session Stop", async () => {
    const h = setup();
    const session = await h.runner.start(h.cellId, "Task");
    await h.ready();
    h.state.failClose = true;
    h.exit(0, 1);
    await h.live.settled(session.id);
    expect(h.containments).toEqual([session.id]);
    expect(h.opens).toHaveLength(1);
    h.state.paused = undefined;
    await expect(h.runner.start(h.cellId, "again")).rejects.toMatchObject({ status: 409 });
  });
  it("does not leak an alias across session settlement or remove another session's alias", async () => {
    const live = new LiveSessions();
    const first = deferred<void>(),
      second = deferred<void>();
    live.start("desktop-a", "session-a", () => first.promise);
    live.start("desktop-b", "session-b", () => second.promise);
    live.alias("brain-a", "session-a");
    expect(() => live.alias("brain-a", "session-b")).toThrow();
    live.unalias("brain-a", "session-b");
    expect(live.get("brain-a")).toBe("session-a");
    const settled = live.settled("session-a");
    first.resolve();
    await settled;
    expect(live.get("brain-a")).toBeUndefined();
    second.resolve();
    await live.settled("session-b");
  });
});

describe("recovery preserves daemon-owned control", () => {
  it("coalesces duplicate keyd restarts and uses fresh credentials without crash delay", async () => {
    const h = setup();
    const backoff = vi.fn(async () => {});
    h.deps.sleep = backoff;
    const session = await h.runner.start(h.cellId, "Task");
    await h.ready();
    const old = required(session.generation),
      token = session.toolToken;
    await h.health({ online: false });
    await h.health({ online: true, bootId: "boot-b" });
    expect(session.isCurrent(old)).toBe(false);
    await h.health({ online: true, bootId: "boot-b" });
    await h.ready(2);
    expect(h.opens).toHaveLength(2);
    expect(session.toolToken).not.toBe(token);
    expect(h.closed).toEqual([h.starts[0]?.id]);
    expect(backoff).not.toHaveBeenCalled();
  });
  it("fences a second restart while open is pending, then only publishes the latest attempt", async () => {
    const h = setup();
    const session = await h.runner.start(h.cellId, "Task");
    await h.ready();
    const gate = deferred<void>();
    h.state.openGate = gate.promise;
    await h.health({ online: true, bootId: "boot-b" });
    await until(() => h.opens.length === 2);
    await h.health({ online: true, bootId: "boot-c" });
    gate.resolve();
    await h.ready(2);
    expect(h.opens).toHaveLength(3);
    expect(h.starts).toHaveLength(2);
    expect(h.closed).toHaveLength(2);
    expect(session.stopped).toBe(false);
  });
  it("only resumes a keyd outage, preserving budget and takeover pauses", async () => {
    const h = setup();
    const session = await h.runner.start(h.cellId, "Task");
    await h.ready();
    session.setStatus("paused");
    session.append("agent.state", { state: "paused", reason: "budget" });
    await h.health({ online: false });
    await h.health({ online: true, bootId: "boot-a" });
    expect((await session.inbox(0, 0)).items).toEqual([]);
    await h.health({ online: false });
    session.append("agent.state", { state: "paused", reason: "model unavailable" });
    await h.health({ online: true, bootId: "boot-a" });
    expect((await session.inbox(0, 0)).items.map((i) => i.kind)).toEqual(["resume"]);
  });
  it("survives takeover caller crash, keyd changes and user messages until explicit handback", async () => {
    const h = setup();
    const session = await h.runner.start(h.cellId, "Task");
    await h.ready();
    const lease = session.admit(required(session.generation));
    const held = session.takeover("login", "Sign in", undefined, lease);
    const cancelled = expect(held).rejects.toBeDefined();
    await until(() => session.status === "waiting_user");
    const request = required(session.pendingTakeover);
    h.exit(0, 1);
    await cancelled;
    lease.finish();
    await until(() => h.closed.length === 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(360_000);
    expect(h.opens).toHaveLength(1);
    await h.health({ online: true, bootId: "boot-b" });
    session.post("steer", "Later");
    await Promise.resolve();
    expect(h.opens).toHaveLength(1);
    expect(session.status).toBe("waiting_user");
    expect(session.endTakeover(request, "Ready")).toBe(true);
    expect(session.endTakeover(request, "Again")).toBe(false);
    await h.ready(2);
    expect(h.log.read(session.id).filter((e) => e.type === "takeover.end")).toHaveLength(1);
    expect(h.opens).toHaveLength(2);
  });
  it("Stop during takeover ends it once without replacement", async () => {
    const h = setup();
    const session = await h.runner.start(h.cellId, "Task");
    await h.ready();
    const lease = session.admit(required(session.generation));
    const held = session.takeover("login", "Sign in", undefined, lease);
    const cancelled = expect(held).rejects.toBeDefined();
    await until(() => session.status === "waiting_user");
    h.live.stop(session.id);
    await cancelled;
    lease.finish();
    await h.live.settled(session.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(3_660_000);
    await h.health({ online: true, bootId: "boot-b" });
    expect(h.opens).toHaveLength(1);
    expect(h.log.read(session.id).filter((e) => e.type === "takeover.end")).toMatchObject([
      { data: { by: "stop" } },
    ]);
  });
});

it("retains Stop ownership for late uncertainty until the actual tool settles", async () => {
  const h = setup();
  const session = await h.runner.start(h.cellId, "Task");
  await h.ready();
  const lease = session.admit(required(session.generation));
  h.live.stop(session.id);
  await until(() => h.closed.length === 1);
  await Promise.resolve();
  expect(h.live.get(h.cellId)).toBe(session.id);
  expect(h.runner.get(session.id)).toBe(session);
  await h.runner.contain(session, "shell_cleanup_uncertain");
  expect(h.containments).toEqual([session.id]);
  lease.finish();
  await h.live.settled(session.id);
  expect(h.runner.get(session.id)).toBeUndefined();
});

it("rejects a held takeover and a paused/busy cell before durable budget raise, then preserves task spend and frozen model identity", async () => {
  const h = setup();
  const session = await h.runner.start(h.cellId, "Task");
  await h.ready();
  const account = required(h.ledger.get(session.id));
  account.spent = 4;
  const selection = h.runner.selectionOf(session.id);
  expect(selection).toEqual({
    kind: "api",
    roles: [{ role: "main", provider: "anthropic", model: "claude-sonnet-5-5" }],
  });
  h.setSettings({ main: { provider: "ollama", model: "changed" }, taskBudgetUSD: 99 });
  expect(h.runner.selectionOf(session.id)).toEqual(selection);
  h.state.busy = true;
  await expect(h.runner.raiseBudget(session.id, 8)).rejects.toMatchObject({ status: 409 });
  h.state.busy = false;
  h.state.paused = true;
  await expect(h.runner.raiseBudget(session.id, 8)).rejects.toMatchObject({ status: 409 });
  h.state.paused = undefined;
  const taking = session.takeover("login", "Synthetic owned login");
  const failure = taking.catch(() => {});
  await until(() => session.controlHeld);
  await expect(h.runner.raiseBudget(session.id, 8)).rejects.toMatchObject({ status: 409 });
  expect(h.raiseCalls, "takeover/paused cell may not mutate its budget account").toHaveLength(0);
  h.live.stop(session.id);
  await failure;
  await h.live.settled(session.id);
  expect(account).toMatchObject({ limit: 5, spent: 4 });
});
it("a takeover arriving during a budget acknowledgement never enqueues Resume or resets spent", async () => {
  const h = setup();
  const session = await h.runner.start(h.cellId, "Task");
  await h.ready();
  const account = required(h.ledger.get(session.id));
  account.spent = 4;
  const gate = deferred<void>();
  h.state.raiseGate = gate.promise;
  const raise = h.runner.raiseBudget(session.id, 8);
  const failure = expect(raise).rejects.toMatchObject({ status: 409 });
  await until(() => h.raiseCalls.length === 1);
  const before = session.inboxSequence;
  const taking = session.takeover("login", "Synthetic owned login");
  const takingFailure = taking.catch(() => {});
  await until(() => session.controlHeld);
  gate.resolve();
  await failure;
  expect(session.inboxSequence, "late budget acknowledgement must not Resume during takeover").toBe(
    before,
  );
  expect(account.spent).toBe(4);
  h.live.stop(session.id);
  await takingFailure;
  await h.live.settled(session.id);
});
