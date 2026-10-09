import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import type { StopOutcome } from "../gateway/kill-switch.ts";
import { stopAll } from "./stop-all.ts";
import { RoutineStore } from "./store.ts";

const ok: StopOutcome = { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-stop-all-"));
  const store = new RoutineStore(home, { now: () => 1, zone: () => "Europe/London" });
  cleanup.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const cells = new FakeOrchestrator();
  const busy = ulid(),
    idle = ulid(),
    session = ulid();
  for (const id of [busy, idle])
    cells.cells.set(id, { id, state: "ready", scale: 2, createdAt: "", stream: NO_STREAM });
  const live = new Map([[busy, session]]);
  const order: string[] = [];
  const killSwitch = {
    stopSession: vi.fn(async (id: string): Promise<StopOutcome | undefined> => {
      order.push(
        `stop ${id} with ${store.list().filter((r) => r.state === "active").length} active routines`,
      );
      live.delete(busy);
      const cell = cells.get(busy);
      if (cell) cells.emit({ ...cell, paused: true });
      return ok;
    }),
    stopIdleCell: vi.fn(async (id: string): Promise<StopOutcome | undefined> => {
      const cell = cells.get(id);
      if (!cell || cell.paused) return undefined;
      cells.emit({ ...cell, paused: true });
      return ok;
    }),
  };
  const audit = { append: vi.fn() };
  const publish = vi.fn();
  const routine = store.create(
    { name: "Morning bills", instruction: "x", when: { kind: "daily", time: "08:30" } },
    { state: "active" },
  );
  const deps = {
    cells,
    live: { get: (id: string) => live.get(id) },
    killSwitch,
    store,
    launcher: { cancelAll: vi.fn(() => 1) },
    scheduler: { replan: vi.fn() },
    audit,
    publish,
    now: () => 42,
  };
  return { deps, store, routine, killSwitch, audit, publish, order, busy, idle, session };
}

describe("stop everything", () => {
  it("pauses routines before stopping anything, then stops tasks and freezes idle computers", async () => {
    const f = fixture();
    const outcome = await stopAll(f.deps, "user");
    expect(f.order).toEqual([`stop ${f.session} with 0 active routines`]);
    expect(outcome).toEqual({
      sessions: [{ sessionId: f.session, cellId: f.busy, outcome: ok }],
      cells: [{ cellId: f.idle, outcome: ok }],
      routinesPaused: 1,
      launchesCancelled: 1,
      confirmed: true,
    });
    expect(f.deps.scheduler.replan).toHaveBeenCalled();
    expect(f.audit.append).toHaveBeenCalledWith({ at: 42, by: "user", outcome });
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "routine.changed",
        routineId: f.routine.id,
        state: "paused",
      }),
    );
  });

  it("is idempotent", async () => {
    const f = fixture();
    await stopAll(f.deps, "user");
    f.deps.launcher.cancelAll.mockReturnValue(0);
    expect(await stopAll(f.deps, "cli")).toEqual({
      sessions: [],
      cells: [],
      routinesPaused: 0,
      launchesCancelled: 0,
      confirmed: true,
    });
  });

  it("reports an unconfirmed stop", async () => {
    const f = fixture();
    f.killSwitch.stopSession.mockResolvedValueOnce({
      revoked: false,
      paused: false,
      closed: false,
      stopped: false,
      errors: ["keyd: could not confirm completion"],
    });
    expect((await stopAll(f.deps, "user")).confirmed).toBe(false);
  });

  it("freezes the computer when its task ended in between", async () => {
    const f = fixture();
    f.killSwitch.stopSession.mockResolvedValueOnce(undefined);
    const outcome = await stopAll(f.deps, "user");
    expect(f.killSwitch.stopIdleCell).toHaveBeenCalledWith(f.busy);
    expect(outcome.cells.map((c) => c.cellId).sort()).toEqual([f.busy, f.idle].sort());
  });

  it("still answers when the audit line cannot be written", async () => {
    const f = fixture();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    f.audit.append.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect((await stopAll(f.deps, "user")).confirmed).toBe(true);
    quiet.mockRestore();
  });
});
