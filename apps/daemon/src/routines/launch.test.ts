import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTONOMY,
  type RoutineAppEvent,
  type RoutineDraft,
  ulid,
} from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, type TaskStartOptions } from "../agent/runner.ts";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { RoutineLauncher } from "./launch.ts";
import { askFirst, ExpiredRuns } from "./policy.ts";
import { stopAll } from "./stop-all.ts";
import { RoutineStore } from "./store.ts";
import { FakeClock } from "./testing/fake-clock.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
const DUE = Date.parse("2026-10-12T07:30:00Z");
const draft: RoutineDraft = {
  name: "Morning bills",
  instruction: "Check statements and save PDFs to Bills.",
  when: { kind: "weekdays", time: "08:30" },
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}

function fixture(cell: Partial<CellSummary> | null = {}) {
  const home = mkdtempSync(join(tmpdir(), "ld-launch-"));
  const clock = new FakeClock("2026-10-12T07:30:00Z");
  const store = new RoutineStore(home, { now: clock.now, zone: () => "Europe/London" });
  const log = new EventLog(home);
  cleanup.push(() => {
    store.close();
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  const cells = new FakeOrchestrator();
  const cellId = ulid();
  if (cell !== null)
    cells.cells.set(cellId, {
      id: cellId,
      state: "ready",
      scale: 2,
      createdAt: "2026-10-01T00:00:00Z",
      stream: NO_STREAM,
      ...cell,
    });
  const live = new Map<string, string>();
  const idle = new Set<string>(),
    parked = new Set<string>();
  const finish = (id: string, reason: "done" | "stopped" | "error") => {
    log.append(id, { type: "session.end", agent: "main", data: { reason } });
    for (const [c, s] of live) if (s === id) live.delete(c);
  };
  const runner = {
    start: vi.fn(async (c: string, task: string, options: TaskStartOptions) => {
      // Like AgentRunner.start: a busy computer refuses a second task.
      const current = live.get(c);
      if (current !== undefined && !idle.has(current))
        throw new AgentError(409, "a task is already running on this computer");
      const id = log.createSession(task.slice(0, 200));
      log.append(id, {
        type: "session.start",
        agent: "main",
        data: {
          screen: { w: 2560, h: 1600, scale: 2 },
          os: "linux",
          title: task.slice(0, 200),
          ...(options.origin ? { origin: options.origin } : {}),
        },
      });
      live.set(c, id);
      return { id };
    }),
    end: vi.fn((id: string) => {
      queueMicrotask(() => finish(id, "stopped"));
      return true;
    }),
    live: (c: string) => live.get(c),
    busy: (c: string) => {
      const id = live.get(c);
      return id !== undefined && !idle.has(id);
    },
    parked: (id: string) => parked.has(id),
    post: vi.fn((id: string, _text: string) => idle.has(id)),
    settled: async () => {},
    title: () => "Find flights",
  };
  const published: RoutineAppEvent[] = [];
  const expired = new ExpiredRuns();
  let docker = true;
  const stop = vi.spyOn(cells, "stop");
  const start = vi.spyOn(cells, "start");
  const launcher = new RoutineLauncher({
    store,
    cells,
    runner,
    events: log,
    expired,
    clock,
    dockerAvailable: async () => docker,
    userAutonomy: () => DEFAULT_AUTONOMY,
    publish: (event) => published.push(event),
  });
  const session = () =>
    required(runner.start.mock.results.at(-1)?.value as Promise<{ id: string }> | undefined);
  return {
    clock,
    store,
    log,
    cells,
    cellId,
    live,
    idle,
    parked,
    runner,
    published,
    expired,
    launcher,
    stop,
    start,
    finish,
    session,
    setDocker: (value: boolean) => {
      docker = value;
    },
    routine: (extra: Partial<RoutineDraft> = {}) =>
      store.create({ ...draft, ...extra }, { state: "active" }),
  };
}
const outcomes = (published: RoutineAppEvent[]) =>
  published.map((e) => (e.type === "routine.run" ? e.outcome : e.type));

describe("routine launcher", () => {
  it("starts a stopped computer, runs with the routine's options, records done, then shuts the computer down", async () => {
    const f = fixture({ state: "stopped" });
    const routine = f.routine({ budgetUSD: 0.5 });
    const launching = f.launcher.launch(routine, DUE);
    await f.clock.flush();
    expect(f.start).toHaveBeenCalledWith(f.cellId);
    f.cells.emit({ ...required(f.cells.get(f.cellId)), state: "ready" });
    const run = await launching;
    expect(run).toMatchObject({ outcome: "running", dueAt: DUE });
    expect(f.runner.start).toHaveBeenCalledWith(f.cellId, draft.instruction, {
      origin: {
        kind: "routine",
        routineId: routine.id,
        runId: run.id,
        name: "Morning bills",
        dueAt: "2026-10-12T07:30:00.000Z",
      },
      autonomy: askFirst(DEFAULT_AUTONOMY),
      budgetUSD: 0.5,
      approvalWindowMs: 3_600_000,
      idleMs: 0,
      run: {
        kind: "routine",
        name: "Morning bills",
        profile: "ask_first",
        approvalWindowMinutes: 60,
      },
    });
    const { id } = await f.session();
    f.log.append(id, {
      type: "task.result",
      agent: "main",
      data: { summary: "2 new statements", files: [] },
    });
    f.finish(id, "done");
    await f.clock.flush();
    expect(f.store.lastRun(routine.id)).toMatchObject({
      outcome: "done",
      note: "2 new statements",
      sessionId: id,
    });
    expect(f.stop).toHaveBeenCalledWith(f.cellId);
    expect(outcomes(f.published)).toEqual(["running", "done"]);
  });

  it("follows the user's spending settings when the routine sets no limit", async () => {
    const f = fixture();
    await f.launcher.launch(f.routine(), DUE);
    expect(required(f.runner.start.mock.calls[0])[2]).not.toHaveProperty("budgetUSD");
  });

  it("leaves a computer that was already on running", async () => {
    const f = fixture();
    const routine = f.routine();
    await f.launcher.launch(routine, DUE);
    f.finish((await f.session()).id, "done");
    await f.clock.flush();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("skips a frozen computer without resuming it", async () => {
    const f = fixture({ paused: true });
    const run = await f.launcher.launch(f.routine(), DUE);
    expect(run).toMatchObject({
      outcome: "skipped",
      note: "Your computer is stopped. Unfreeze it to let routines run.",
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.runner.start).not.toHaveBeenCalled();
  });

  it("skips when there is no computer yet", async () => {
    const f = fixture(null);
    expect(await f.launcher.launch(f.routine(), DUE)).toMatchObject({
      outcome: "skipped",
      note: "No computer is set up yet.",
    });
  });

  it("fails when Docker is not running, and that is worth a notification", async () => {
    const f = fixture({ state: "stopped" });
    f.setDocker(false);
    expect(await f.launcher.launch(f.routine(), DUE)).toMatchObject({
      outcome: "failed",
      note: "Docker is not running.",
    });
    expect(f.published.at(-1)).toMatchObject({
      outcome: "failed",
      notify: true,
      title: "Morning bills: Failed",
    });
  });

  it("queues behind a busy computer and starts when it is free", async () => {
    const f = fixture();
    f.live.set(f.cellId, ulid());
    const launching = f.launcher.launch(f.routine(), DUE);
    await f.clock.flush();
    f.clock.advance(60_000);
    await f.clock.flush();
    expect(f.runner.start).not.toHaveBeenCalled();
    f.live.delete(f.cellId);
    f.clock.advance(60_000);
    expect(await launching).toMatchObject({ outcome: "running" });
  });

  it("gives up after 30 minutes of a busy computer", async () => {
    const f = fixture();
    f.live.set(f.cellId, ulid());
    const launching = f.launcher.launch(f.routine(), DUE);
    for (let i = 0; i < 31; i++) {
      await f.clock.flush();
      f.clock.advance(60_000);
    }
    expect(await launching).toMatchObject({ outcome: "skipped", note: "computer busy" });
  });

  it("never runs the same routine twice at once: an overlapping due time is skipped", async () => {
    const f = fixture();
    const routine = f.routine();
    await f.launcher.launch(routine, DUE);
    const overlap = await f.launcher.launch(routine, DUE + 3_600_000);
    expect(overlap).toMatchObject({
      outcome: "skipped",
      note: "The previous run was still going.",
    });
    expect(f.runner.start).toHaveBeenCalledTimes(1);
    f.finish((await f.session()).id, "done");
    await f.clock.flush();
    expect(await f.launcher.launch(routine, DUE + 7_200_000)).toMatchObject({
      outcome: "running",
    });
  });

  it("ends the run Needs you · expired when an approval times out", async () => {
    const f = fixture();
    const routine = f.routine();
    await f.launcher.launch(routine, DUE);
    const { id } = await f.session();
    f.log.append(id, {
      type: "approval.resolve",
      agent: "main",
      data: { approvalId: ulid(), decision: "deny", by: "timeout" },
    });
    expect(f.expired.has(id)).toBe(true);
    f.clock.advance(120_000);
    await f.clock.flush();
    expect(f.runner.end).toHaveBeenCalledWith(id);
    expect(f.store.lastRun(routine.id)?.outcome).toBe("needs_you_expired");
    expect(f.expired.has(id)).toBe(false);
  });

  it("ends a question nobody answers within the window", async () => {
    const f = fixture();
    const routine = f.routine({ approvalWindowMinutes: 30 });
    await f.launcher.launch(routine, DUE);
    const { id } = await f.session();
    f.log.append(id, {
      type: "ask.request",
      agent: "main",
      data: { askId: ulid(), question: "Which bank?", options: [], allowText: true },
    });
    f.parked.add(id);
    expect(f.store.lastRun(routine.id)?.outcome).toBe("needs_you");
    f.clock.advance(30 * 60_000);
    await f.clock.flush();
    expect(f.store.lastRun(routine.id)?.outcome).toBe("needs_you_expired");
  });

  it("ends the run on a task spending limit", async () => {
    const f = fixture();
    const routine = f.routine({ budgetUSD: 0.5 });
    await f.launcher.launch(routine, DUE);
    const { id } = await f.session();
    f.log.append(id, {
      type: "budget.exceeded",
      agent: "main",
      data: { scope: "task", taskId: id, limitUSD: 0.5, spentUSD: 0.5 },
    });
    await f.clock.flush();
    expect(f.store.lastRun(routine.id)).toMatchObject({
      outcome: "budget",
      note: "Spending limit reached",
    });
  });

  it("ends the run on the daily spending limit too", async () => {
    const f = fixture();
    const routine = f.routine();
    await f.launcher.launch(routine, DUE);
    const { id } = await f.session();
    f.log.append(id, {
      type: "budget.exceeded",
      agent: "main",
      data: { scope: "day", limitUSD: 5, spentUSD: 5 },
    });
    await f.clock.flush();
    expect(f.store.lastRun(routine.id)?.outcome).toBe("budget");
  });

  it("notifies when the result changes, not for the same result twice", async () => {
    const f = fixture();
    const routine = f.routine();
    for (const summary of ["2 new statements", "2 new statements", "1 new statement"]) {
      await f.launcher.launch(routine, DUE);
      const { id } = await f.session();
      f.log.append(id, { type: "task.result", agent: "main", data: { summary, files: [] } });
      f.finish(id, "done");
      await f.clock.flush();
    }
    expect(
      f.published
        .filter((e) => e.type === "routine.run" && e.outcome === "done")
        .map((e) => e.type === "routine.run" && e.notify),
    ).toEqual([true, false, true]);
  });

  it("posts a follow-up into its idle task as an untrusted note", async () => {
    const f = fixture();
    const original = ulid();
    f.live.set(f.cellId, original);
    f.idle.add(original);
    const followUp = f.store.create(
      {
        name: "Follow-up",
        instruction: "Check the parcel",
        when: { kind: "once", date: "2026-10-12", time: "08:30" },
      },
      {
        state: "active",
        kind: "follow_up",
        followUp: { sessionId: original, note: "Check the parcel" },
      },
    );
    expect(await f.launcher.launch(followUp, DUE)).toMatchObject({
      outcome: "done",
      note: "Sent to the task.",
    });
    expect(f.runner.post).toHaveBeenCalledWith(
      original,
      expect.stringContaining(
        '<untrusted source="follow-up note">\nCheck the parcel\n</untrusted>',
      ),
    );
    expect(f.runner.start).not.toHaveBeenCalled();
  });

  it("starts a linked task when the follow-up's task has ended", async () => {
    const f = fixture();
    const original = ulid();
    const followUp = f.store.create(
      {
        name: "Follow-up",
        instruction: "Check the parcel",
        when: { kind: "once", date: "2026-10-12", time: "08:30" },
      },
      {
        state: "active",
        kind: "follow_up",
        followUp: { sessionId: original, note: "Check the parcel" },
      },
    );
    await f.launcher.launch(followUp, DUE);
    const [, task, options] = required(f.runner.start.mock.calls[0]);
    expect(task).toContain('Follow up on the earlier task "Find flights"');
    expect(task).toContain("<untrusted");
    expect(options.origin).toMatchObject({ kind: "follow_up", sessionId: original });
  });

  it("does not shut down a computer someone is watching", async () => {
    const f = fixture({ state: "stopped" });
    const launching = f.launcher.launch(f.routine(), DUE);
    await f.clock.flush();
    f.cells.emit({
      ...required(f.cells.get(f.cellId)),
      state: "ready",
      stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
    });
    await launching;
    f.finish((await f.session()).id, "done");
    await f.clock.flush();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("parks on Needs you while an approval waits, and says so once", async () => {
    const f = fixture();
    const routine = f.routine();
    await f.launcher.launch(routine, DUE);
    const { id } = await f.session();
    f.log.append(id, {
      type: "approval.request",
      agent: "main",
      data: {
        approvalId: ulid(),
        generation: 1,
        revision: 1,
        expiresAt: DUE + 3_600_000,
        actionClass: "send",
        risk: "high",
        title: "Send message",
        kind: "send",
        preview: { fields: [] },
      },
    });
    expect(f.store.lastRun(routine.id)?.outcome).toBe("needs_you");
    expect(f.published.at(-1)).toMatchObject({
      outcome: "needs_you",
      notify: true,
      title: "Morning bills: Needs you",
    });
    f.log.append(id, {
      type: "approval.resolve",
      agent: "main",
      data: { approvalId: ulid(), decision: "approve", by: "user" },
    });
    expect(f.store.lastRun(routine.id)?.outcome).toBe("running");
  });

  it("does not treat a card cancelled by Pause or takeover as an expired window", async () => {
    const f = fixture();
    const routine = f.routine();
    await f.launcher.launch(routine, DUE);
    const { id } = await f.session();
    f.log.append(id, {
      type: "approval.resolve",
      agent: "main",
      data: { approvalId: ulid(), decision: "deny", by: "timeout", note: "Approval cancelled." },
    });
    expect(f.expired.has(id)).toBe(false);
    f.clock.advance(120_000);
    await f.clock.flush();
    expect(f.runner.end).not.toHaveBeenCalled();
  });

  it("records Failed when dot gives up", async () => {
    const f = fixture();
    const routine = f.routine();
    await f.launcher.launch(routine, DUE);
    const { id } = await f.session();
    f.log.append(id, {
      type: "agent.state",
      agent: "main",
      data: { state: "idle", reason: "gave up" },
    });
    f.finish(id, "done");
    await f.clock.flush();
    expect(f.store.lastRun(routine.id)).toMatchObject({
      outcome: "failed",
      note: "dot couldn't finish this run.",
    });
  });

  it("runs two routines due at the same time one after the other", async () => {
    const f = fixture();
    const first = f.launcher.launch(f.routine(), DUE);
    const second = f.launcher.launch(f.routine({ name: "Second" }), DUE);
    expect(await first).toMatchObject({ outcome: "running" });
    await f.clock.flush();
    expect(f.runner.start).toHaveBeenCalledTimes(2);
    const winner = await required(
      f.runner.start.mock.results[0]?.value as Promise<{ id: string }> | undefined,
    );
    f.finish(winner.id, "done");
    f.clock.advance(60_000);
    expect(await second).toMatchObject({ outcome: "running" });
    expect(f.runner.start).toHaveBeenCalledTimes(3);
  });

  it("marks runs left open by a restart as failed", () => {
    const f = fixture();
    const routine = f.routine();
    f.store.recordRun({
      routineId: routine.id,
      dueAt: DUE,
      startedAt: DUE,
      endedAt: null,
      sessionId: ulid(),
      outcome: "running",
      note: "",
    });
    expect(f.launcher.recoverInterrupted()).toBe(1);
    expect(f.store.lastRun(routine.id)).toMatchObject({
      outcome: "failed",
      note: "localDot restarted during this run.",
    });
  });
});

describe("Stop everything during a launch", () => {
  it("cancels a launch that is waiting for the computer", async () => {
    const f = fixture();
    f.live.set(f.cellId, ulid());
    const launching = f.launcher.launch(f.routine(), DUE);
    await f.clock.flush();
    const outcome = await stopAll(
      {
        cells: f.cells,
        live: { get: (c: string) => f.live.get(c) },
        killSwitch: {
          stopSession: async () => ({
            revoked: true,
            paused: true,
            closed: false,
            stopped: false,
            errors: [],
          }),
          stopIdleCell: async () => undefined,
        },
        store: f.store,
        launcher: f.launcher,
        scheduler: { replan: () => {} },
        audit: { append: () => {} },
        publish: () => {},
        now: f.clock.now,
      },
      "user",
    );
    expect(outcome.launchesCancelled).toBe(1);
    expect(await launching).toMatchObject({
      outcome: "skipped",
      note: "Stopped by Stop everything.",
    });
    f.live.delete(f.cellId);
    f.clock.advance(120_000);
    await f.clock.flush();
    expect(f.runner.start).not.toHaveBeenCalled();
  });
});
