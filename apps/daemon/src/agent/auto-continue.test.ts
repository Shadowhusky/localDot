import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanProvider, PlanUsage } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AutoContinueDeps,
  AutoContinueScheduler,
  MAX_TRIES,
  type WaitingTask,
} from "./auto-continue.ts";

const SESSION = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const NEXT = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const CELL = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const LIMIT = "claude code plan limit reached";
const START = Date.UTC(2026, 10, 10, 12, 0, 0);
const MIN = 60_000;

const homes: string[] = [];
let home: string;
beforeEach(() => {
  vi.useFakeTimers({ now: START });
  home = mkdtempSync(join(tmpdir(), "auto-continue-"));
  homes.push(home);
});
afterEach(() => {
  vi.useRealTimers();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The Claude plan at its limit until `resetsAt` (ms), as its last reading said at `observedAt`.
const limited = (resetsAt: number | undefined, observedAt = Date.now()): PlanUsage => ({
  provider: "claude-code",
  windows: [],
  limitReached: true,
  ...(resetsAt !== undefined ? { limitResetsAt: Math.round(resetsAt / 1000) } : {}),
  observedAt,
});
const free = (observedAt = Date.now()): PlanUsage => ({
  provider: "claude-code",
  windows: [],
  limitReached: false,
  observedAt,
});

function fixture(options: { plan?: PlanUsage; enabled?: boolean } = {}) {
  const task = {
    id: SESSION,
    cellId: CELL,
    inboxSequence: 3,
    status: "paused",
    stopped: false,
    controlHeld: false,
  };
  const state = {
    plan: options.plan as PlanUsage | undefined,
    // What reading the plan's own app finds, when it is read.
    read: undefined as PlanUsage | undefined,
    enabled: options.enabled ?? true,
    live: task as WaitingTask | undefined,
    latest: SESSION,
    model: "claude-code/opus" as string | undefined,
  };
  const announced: { sessionId: string; autoContinue: unknown }[] = [];
  const resumed: string[] = [];
  const carried: string[] = [];
  const deps: AutoContinueDeps = {
    home,
    enabled: () => state.enabled,
    plan: (provider: PlanProvider) => (provider === "claude-code" ? state.plan : undefined),
    refresh: async () => {
      if (state.read) state.plan = { ...state.read, observedAt: Date.now() };
    },
    live: (id) => (id === SESSION ? state.live : undefined),
    latest: () => state.latest,
    model: () => state.model,
    announce: (sessionId, paused) => {
      expect(paused.reason).toBe(LIMIT);
      announced.push({ sessionId, autoContinue: paused.autoContinue });
    },
    resume: (waiting) => {
      resumed.push(waiting.id);
    },
    carryOn: async ({ sessionId }) => {
      carried.push(sessionId);
      return NEXT;
    },
    random: () => 0.5,
  };
  const scheduler = new AutoContinueScheduler(deps);
  scheduler.start();
  return { task, state, deps, scheduler, announced, resumed, carried };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("continuing a task after its plan's limit", () => {
  it("continues the task a minute after the reset the plan reported", async () => {
    const resets = START + 95 * MIN;
    const f = fixture({ plan: limited(resets) });
    f.scheduler.limited(f.task, LIMIT, "You've hit your limit");
    expect(f.announced).toEqual([{ sessionId: SESSION, autoContinue: { at: resets + 60_000 } }]);
    f.state.read = free();
    await vi.advanceTimersByTimeAsync(95 * MIN + 59_000);
    expect(f.resumed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.resumed).toEqual([SESSION]);
  });

  it("waits for the next reset when the plan is still at its limit", async () => {
    const first = START + 30 * MIN;
    const week = START + 3 * 24 * 60 * MIN;
    const f = fixture({ plan: limited(first) });
    f.scheduler.limited(f.task, LIMIT);
    // The five hours reset, but the weekly limit still holds.
    f.state.read = limited(week);
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(f.resumed).toEqual([]);
    expect(f.announced.at(-1)?.autoContinue).toEqual({ at: week + 60_000 });
    f.state.read = free();
    await vi.advanceTimersByTimeAsync(week + 60_000 - Date.now());
    expect(f.resumed).toEqual([SESSION]);
  });

  it("looks at a plan that didn't say when it resets every ten minutes, then continues", async () => {
    const f = fixture({ plan: limited(undefined) });
    f.state.read = limited(undefined);
    f.scheduler.limited(f.task, LIMIT);
    await settle();
    expect(f.announced.at(-1)?.autoContinue).toEqual({ at: START + 10 * MIN, checking: true });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(f.resumed).toEqual([]);
    expect(f.announced.at(-1)?.autoContinue).toEqual({
      at: START + 20 * MIN,
      checking: true,
    });
    f.state.read = free();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(f.resumed).toEqual([SESSION]);
  });

  it("takes the reset time a fresh reading of the plan gives", async () => {
    const resets = START + 40 * MIN;
    const f = fixture();
    f.state.read = limited(resets);
    f.scheduler.limited(f.task, LIMIT);
    await settle();
    expect(f.announced.at(-1)?.autoContinue).toEqual({ at: resets + 60_000 });
  });

  it("gives up after a few hours of a plan that stays at its limit, and says so", async () => {
    const f = fixture({ plan: limited(undefined) });
    f.state.read = limited(undefined);
    f.scheduler.limited(f.task, LIMIT);
    await vi.advanceTimersByTimeAsync(4 * 60 * MIN + MIN);
    expect(f.resumed).toEqual([]);
    expect(f.announced.at(-1)?.autoContinue).toEqual({ off: "gave_up" });
    expect(f.scheduler.list()).toEqual([]);
  });

  it("gives up when continuing keeps meeting the limit straight away", async () => {
    const f = fixture({ plan: free() });
    for (let i = 0; i < MAX_TRIES; i++) {
      f.scheduler.limited(f.task, LIMIT);
      await vi.advanceTimersByTimeAsync(11 * MIN);
      expect(f.resumed).toHaveLength(i + 1);
    }
    f.scheduler.limited(f.task, LIMIT);
    expect(f.announced.at(-1)?.autoContinue).toEqual({ off: "gave_up" });
    expect(f.scheduler.list()).toEqual([]);
  });

  it("leaves the task alone when the user sends a message, stops it or continues it", async () => {
    const resets = START + 10 * MIN;
    const f = fixture({ plan: limited(resets) });
    f.state.read = free();
    f.scheduler.limited(f.task, LIMIT);
    // A message moves a task on from its card: it goes on now, with no word from the wait.
    f.scheduler.observe(SESSION, { type: "message.user", data: {} });
    await settle();
    expect(f.announced).toHaveLength(1);
    expect(f.scheduler.list()).toEqual([]);

    f.scheduler.limited(f.task, LIMIT);
    f.scheduler.observe(SESSION, { type: "session.end", data: { reason: "stopped" } });
    f.scheduler.limited(f.task, LIMIT);
    f.scheduler.observe(SESSION, { type: "agent.state", data: { state: "thinking" } });
    // dot's own word about the wait is no reason to stop waiting.
    f.scheduler.limited(f.task, LIMIT);
    f.scheduler.observe(SESSION, { type: "agent.state", data: { state: "paused", reason: LIMIT } });
    expect(f.scheduler.list()).toHaveLength(1);
    f.task.inboxSequence = 4;
    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(f.resumed).toEqual([]);
    expect(f.scheduler.list()).toEqual([]);
  });

  it("doesn't continue on a model the user has since switched from", async () => {
    const f = fixture({ plan: limited(START + 10 * MIN) });
    f.state.read = free();
    f.scheduler.limited(f.task, LIMIT);
    f.state.model = "chatgpt/gpt-5.5";
    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(f.resumed).toEqual([]);
    expect(f.announced.at(-1)?.autoContinue).toEqual({ off: "cancelled" });
  });

  it("stops waiting on Don't continue, or when auto-continue is turned off", async () => {
    const f = fixture({ plan: limited(START + 10 * MIN) });
    f.scheduler.limited(f.task, LIMIT);
    expect(f.scheduler.cancel(SESSION)).toBe(true);
    expect(f.scheduler.cancel(SESSION)).toBe(false);
    expect(f.announced.at(-1)?.autoContinue).toEqual({ off: "cancelled" });
    f.scheduler.limited(f.task, LIMIT);
    f.scheduler.cancelAll();
    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(f.resumed).toEqual([]);

    const off = fixture({ plan: limited(START + 10 * MIN), enabled: false });
    off.scheduler.limited(off.task, LIMIT);
    // Said all the same, so the user hears of the limit.
    expect(off.announced).toEqual([{ sessionId: SESSION, autoContinue: { off: "disabled" } }]);
    expect(off.scheduler.list()).toEqual([]);
    // A shared link's task waits for the owner.
    const guest = fixture({ plan: limited(START + 10 * MIN) });
    guest.scheduler.limited(guest.task, LIMIT, undefined, false);
    expect(guest.announced).toEqual([{ sessionId: SESSION, autoContinue: { off: "disabled" } }]);
    expect(guest.scheduler.list()).toEqual([]);
  });

  it("waits while the user holds the computer", async () => {
    const f = fixture({ plan: limited(START + 10 * MIN) });
    f.state.read = free();
    f.scheduler.limited(f.task, LIMIT);
    f.task.controlHeld = true;
    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(f.resumed).toEqual([]);
    f.task.controlHeld = false;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(f.resumed).toEqual([SESSION]);
  });

  it("keeps the schedule through a restart and carries the ended task on", async () => {
    const resets = START + 30 * MIN;
    const before = fixture({ plan: limited(resets) });
    before.scheduler.limited(before.task, LIMIT);
    await before.scheduler.close();
    // The shutdown ends the task; that is no reason to stop waiting.
    before.scheduler.observe(SESSION, { type: "session.end", data: { reason: "stopped" } });

    const after = fixture({ plan: limited(resets) });
    after.state.live = undefined;
    after.state.read = free();
    expect(after.scheduler.list()).toMatchObject([{ sessionId: SESSION, at: resets + 60_000 }]);
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(after.carried).toEqual([SESSION]);
    expect(after.resumed).toEqual([]);
    // The carried-on task is the one that counts tries now; a restart forgets it.
    expect(after.scheduler.list()).toMatchObject([{ sessionId: NEXT }]);
    expect(fixture().scheduler.list()).toEqual([]);
  });

  it("doesn't carry on an ended task whose conversation has moved on", async () => {
    const before = fixture({ plan: limited(START + 10 * MIN) });
    before.scheduler.limited(before.task, LIMIT);
    await before.scheduler.close();
    const after = fixture({ plan: limited(START + 10 * MIN) });
    after.state.live = undefined;
    after.state.latest = NEXT;
    after.state.read = free();
    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(after.carried).toEqual([]);
    expect(after.scheduler.list()).toEqual([]);
  });
});
