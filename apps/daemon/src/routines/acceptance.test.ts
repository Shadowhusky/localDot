import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTONOMY, type KeydRecord, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainCell, OpenBrain } from "../agent/brain-cell.ts";
import { MemoryStore } from "../agent/memory.ts";
import { AgentRunner } from "../agent/runner.ts";
import { fixtureModelAdmission } from "../agent/testing/model-admission.ts";
import { TranscriptStore } from "../agent/transcript.ts";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { type CellState, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import { RoutineLauncher } from "./launch.ts";
import { ExpiredRuns } from "./policy.ts";
import { agentRunnerPort } from "./runner-port.ts";
import { RoutineScheduler } from "./scheduler.ts";
import { RoutineStore } from "./store.ts";
import { FakeClock } from "./testing/fake-clock.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("never reached");
}

// The real runner, launcher and scheduler over fakes for the computer, the brain and keyd: a
// routine due in 2 s runs as an ordinary task, ends, and its run records how.
function acceptance(cellState: CellState) {
  const home = mkdtempSync(join(tmpdir(), "ld-routine-acceptance-"));
  const log = new EventLog(home);
  const live = new LiveSessions();
  const clock = new FakeClock("2026-10-12T07:29:58Z");
  const store = new RoutineStore(home, { now: clock.now, zone: () => "Europe/London" });
  const cells = new FakeOrchestrator();
  const cellId = ulid();
  cells.cells.set(cellId, {
    id: cellId,
    state: cellState,
    scale: 2,
    createdAt: "2026-10-01T00:00:00Z",
    stream: NO_STREAM,
  });
  const startCalls: string[] = [],
    stopCalls: string[] = [],
    opens: OpenBrain[] = [];
  const startCell = cells.start.bind(cells),
    stopCell = cells.stop.bind(cells);
  cells.start = async (id) => {
    startCalls.push(id);
    await startCell(id);
  };
  cells.stop = async (id) => {
    stopCalls.push(id);
    await stopCell(id);
  };
  const exits = new Map<string, (code: number) => void>();
  const brains = {
    open: async (o: OpenBrain): Promise<BrainCell> => {
      opens.push(o);
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
        proxyToken: "p".repeat(43),
        toolToken: "t".repeat(43),
        surrogates: { anthropic: `ld_llm_${"0".repeat(22)}_abcdef` },
      };
    },
    start: async () => {},
    exited: (brain: BrainCell, signal: AbortSignal) =>
      new Promise<number | undefined>((resolve) => {
        const done = (code: number | undefined) => {
          exits.delete(brain.sessionId);
          resolve(code);
        };
        exits.set(brain.sessionId, (code) => done(code));
        signal.addEventListener("abort", () => done(undefined), { once: true });
      }),
    close: async () => {},
  };
  const admission = fixtureModelAdmission(brains);
  const at = "2026-10-02T00:00:00Z";
  const keys: KeydRecord[] = [
    { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: at, updatedAt: at },
  ];
  const runner = new AgentRunner({
    home,
    eventLog: log,
    live,
    cell: (id) => cells.get(id),
    brains,
    keyd: {
      ...admission,
      secrets: async () => keys,
      beginTask: async () => {},
    },
    settings: () => ({
      main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
    }),
    catalog: () => normalizeCatalog(MODELS_DEV_FIXTURE, at),
    memory: new MemoryStore(home),
    transcripts: new TranscriptStore(home),
    installSkills: async () => [],
    waitForUploads: async () => {},
    stopSession: async (id) => {
      live.stop(id);
      return { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
    },
    sleep: async () => {},
  });
  const launcher = new RoutineLauncher({
    store,
    cells,
    runner: agentRunnerPort(runner, live, log),
    events: log,
    dockerAvailable: async () => true,
    userAutonomy: () => DEFAULT_AUTONOMY,
    expired: new ExpiredRuns(),
    publish: () => {},
    clock,
  });
  const scheduler = new RoutineScheduler({ store, launcher, publish: () => {}, clock });
  cleanup.push(async () => {
    scheduler.stop();
    await runner.close();
    store.close();
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  const routine = (budgetUSD: number | null = null) =>
    store.create(
      {
        name: "Daily log",
        instruction: "Append today's date to ~/Documents/log.txt",
        when: { kind: "daily", time: "08:30" },
        budgetUSD,
      },
      { state: "active" },
    );
  const cell = () => cells.get(cellId);
  // The brain finishes its task: done, as BRAIN_DONE.
  const finishBrain = async () => {
    await until(() => exits.size === 1);
    const [exit] = exits.values();
    exit?.(0);
  };
  return {
    clock,
    store,
    log,
    cells,
    cell,
    startCalls,
    stopCalls,
    opens,
    scheduler,
    routine,
    finishBrain,
  };
}

describe("routines end to end", () => {
  it("a routine due in 2 s starts the stopped computer, runs with its origin, ends done and shuts the computer down", async () => {
    const f = acceptance("stopped");
    const routine = f.routine();
    f.scheduler.start();
    f.clock.advance(2_000);
    await until(() => f.startCalls.length === 1);
    f.cells.emit({ ...(f.cell() as NonNullable<ReturnType<typeof f.cell>>), state: "ready" });
    await until(() => f.store.lastRun(routine.id)?.outcome === "running");
    await f.finishBrain();
    await until(() => f.store.lastRun(routine.id)?.outcome === "done");
    const run = f.store.lastRun(routine.id);
    const start = f.log.read(run?.sessionId as string).find((e) => e.type === "session.start");
    expect(start?.data).toMatchObject({
      title: "Daily log",
      origin: { kind: "routine", routineId: routine.id, runId: run?.id },
    });
    await until(() => f.cell()?.state === "stopped");
    expect(f.stopCalls).toHaveLength(1);
    expect(f.store.get(routine.id)?.nextDueAt).toBe(Date.parse("2026-10-13T07:30:00Z"));
  });

  it("does not shut down a computer that was already on, and passes the run's spending limit", async () => {
    const f = acceptance("ready");
    const routine = f.routine(0.5);
    f.scheduler.start();
    f.clock.advance(2_000);
    await until(() => f.store.lastRun(routine.id)?.outcome === "running");
    expect(f.opens[0]?.budgetUSD).toBe(0.5);
    await f.finishBrain();
    await until(() => f.store.lastRun(routine.id)?.outcome === "done");
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.startCalls).toEqual([]);
    expect(f.stopCalls).toEqual([]);
  });
});
