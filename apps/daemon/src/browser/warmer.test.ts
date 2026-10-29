import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSupervisorState } from "../../../../packages/protocol/src/browser-control.ts";
import { BrowserStartCancelled } from "../cells/browser-ledger.ts";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import type { CellState, CellSummary } from "../cells/types.ts";
import {
  BrowserWarmer,
  type BrowserWarmerDeps,
  RESTARTING_SWEEPS,
  RETRY_MS,
  SILENT_SWEEPS,
  WARM_SWEEP_MS,
} from "./warmer.ts";

const A = "01JXYZ0000000000000000000A",
  B = "01JXYZ0000000000000000000B";

function cell(id: string, patch: Partial<CellSummary> = {}): CellSummary {
  return {
    id,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-09T00:00:00.000Z",
    stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
    ...patch,
  } as CellSummary;
}

function fixture(cells: CellSummary[] = [cell(A)]) {
  const table = new Map(cells.map((entry) => [entry.id, entry]));
  const cellListeners = new Set<(entry: CellSummary) => void>();
  const browserListeners = new Set<(parent: string) => void>();
  const running = new Map<string, string>();
  const states = new Map<string, CellState>();
  let holder: string | undefined;
  let started = 0;
  const run = (parent: string) => {
    running.set(parent, `instance-${++started}`);
  };
  const start = vi.fn(async (parent: string) => {
    run(parent);
    holder = parent;
    return { parentCellId: parent } as ReadyBrowser;
  });
  const health = vi.fn(
    async (parent: string): Promise<"ready" | "restarting" | "unready" | "silent" | undefined> =>
      running.has(parent) ? "ready" : undefined,
  );
  const failure = vi.fn(async (_parent: string): Promise<string | undefined> => undefined);
  const noteProblem = vi.fn();
  const noteRetry = vi.fn();
  const noteOutage = vi.fn();
  const notify = vi.fn();
  const supervisor = vi.fn(
    async (_parent: string): Promise<BrowserSupervisorState | undefined> => undefined,
  );
  const stop = vi.fn(async (parent: string) => {
    running.delete(parent);
    if (holder === parent) holder = undefined;
    for (const listener of browserListeners) listener(parent);
  });
  const report = vi.fn();
  const deps: BrowserWarmerDeps = {
    cells: {
      list: () => [...table.values()],
      get: (id) => table.get(id),
      subscribe: (listener) => {
        cellListeners.add(listener);
        return () => cellListeners.delete(listener);
      },
    },
    browser: {
      start,
      stop,
      health,
      failure,
      noteProblem,
      noteRetry,
      noteOutage,
      supervisor,
      endpoints: (parent) => {
        const instance = running.get(parent);
        return instance ? ({ parentCellId: parent, instance } as ReadyBrowser) : undefined;
      },
      get: (parent) => {
        const state = states.get(parent);
        return state ? { id: parent, parentCellId: parent, state } : undefined;
      },
      profileHolder: () => holder,
      subscribe: (listener) => {
        browserListeners.add(listener);
        return () => browserListeners.delete(listener);
      },
    },
    available: () => true,
    report,
    notify,
  };
  return {
    deps,
    start,
    stop,
    health,
    failure,
    noteProblem,
    noteRetry,
    noteOutage,
    notify,
    supervisor,
    report,
    set(entry: CellSummary) {
      table.set(entry.id, entry);
      for (const listener of cellListeners) listener(entry);
    },
    stopBrowser(parent: string) {
      running.delete(parent);
      if (holder === parent) holder = undefined;
      for (const listener of browserListeners) listener(parent);
    },
    hold(parent: string | undefined, live = true, state?: CellState) {
      holder = parent;
      if (parent && live) run(parent);
      if (parent && state) states.set(parent, state);
    },
    restartBrowser: run,
  };
}

const warmers: BrowserWarmer[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const warmer of warmers.splice(0)) warmer.dispose();
  vi.useRealTimers();
});
const warm = (deps: BrowserWarmerDeps) => {
  const warmer = new BrowserWarmer(deps);
  warmers.push(warmer);
  return warmer;
};

describe("the web browser starts with its computer", () => {
  it("starts once for a ready computer and again after it stops", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledWith(A));
    f.set(cell(A));
    expect(f.start).toHaveBeenCalledTimes(1);
    f.stopBrowser(A);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
  });

  it("waits while the computer is off, paused or being replaced", async () => {
    const f = fixture([cell(A, { state: "stopped" })]);
    warm(f.deps);
    f.set(cell(A, { paused: true }));
    f.set(cell(A, { replacementPending: true }));
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.start).not.toHaveBeenCalled();
    f.set(cell(A));
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledWith(A));
  });

  it("leaves the sign-ins with the computer whose browser has them", async () => {
    const f = fixture([cell(A), cell(B)]);
    f.hold(B);
    warm(f.deps);
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.start).not.toHaveBeenCalled();
    f.hold(undefined);
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("starts its own computer's browser again while an unconfirmed stop still holds the sign-ins", async () => {
    const f = fixture([cell(A), cell(B)]);
    f.hold(A, false, "failed");
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledWith(A));
    expect(f.start).not.toHaveBeenCalledWith(B);
  });

  it("never starts ahead of its own computer's queued stop", async () => {
    const f = fixture([cell(A)]);
    f.hold(A, false, "stopping");
    warm(f.deps);
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS * 2);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("retries a failed start with backoff and gives up while the computer is off", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(new Error("docker busy"));
    f.start.mockRejectedValueOnce(new Error("docker busy"));
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    f.set(cell(A, { state: "stopped" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("does nothing until the browser may start, then catches up on the next sweep", async () => {
    const f = fixture();
    let allowed = false;
    f.deps.available = () => allowed;
    warm(f.deps);
    expect(f.start).not.toHaveBeenCalled();
    allowed = true;
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.start).toHaveBeenCalledWith(A);
  });
});

describe("a running web browser that stops working starts again", () => {
  it("restarts one that can no longer be controlled at the next sweep", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    f.health.mockResolvedValueOnce("unready");
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    expect(f.stop).toHaveBeenCalledWith(A);
    expect(f.report).toHaveBeenCalledWith(
      "the web browser can no longer be controlled; starting it again",
    );
  });

  it("gives one that doesn't answer another sweep before restarting it", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    f.health.mockResolvedValue("silent");
    for (let sweep = 1; sweep < SILENT_SWEEPS; sweep++)
      await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.stop).not.toHaveBeenCalled();
    f.health.mockResolvedValueOnce("ready");
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    for (let sweep = 1; sweep < SILENT_SWEEPS; sweep++)
      await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
  });

  it("leaves running a browser started since it was asked", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    f.health.mockImplementationOnce(async (parent) => {
      f.restartBrowser(parent);
      return "unready";
    });
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.health).toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("says why a start failed", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(new Error("Browser start failed during readiness"));
    warm(f.deps);
    await vi.waitFor(() =>
      expect(f.report).toHaveBeenCalledWith(
        "the web browser couldn't start: Browser start failed during readiness",
      ),
    );
    expect(f.noteProblem).toHaveBeenCalledWith(
      A,
      "The web browser couldn't start: Browser start failed during readiness.",
    );
  });

  it("says why it started a browser again", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    f.health.mockResolvedValueOnce("unready");
    f.failure.mockResolvedValueOnce("The browser process ended (exited on SIGKILL, out of memory)");
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    expect(f.report).toHaveBeenCalledWith(
      "the web browser can no longer be controlled; starting it again: The browser process ended (exited on SIGKILL, out of memory)",
    );
    expect(f.noteProblem).toHaveBeenCalledWith(
      A,
      "The web browser can no longer be controlled (The browser process ended (exited on SIGKILL, out of memory)); localDot started it again.",
    );
  });

  it("logs once what a browser recovered from by itself", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    f.supervisor.mockResolvedValue({
      state: "running",
      restarts: 1,
      lastFailure: {
        kind: "browser_exited",
        detail: "exited on SIGKILL, out of memory",
        recovered: true,
        at: "2026-10-26T12:00:00.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS * 3);
    expect(f.report.mock.calls).toEqual([
      [
        "the web browser recovered by itself: The browser process ended (exited on SIGKILL, out of memory) and was restarted",
      ],
    ]);
    expect(f.noteProblem).toHaveBeenCalledOnce();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("waits for a browser restarting its Chromium in place, within a bound", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    f.health.mockResolvedValue("restarting");
    for (let sweep = 1; sweep < RESTARTING_SWEEPS; sweep++)
      await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    expect(f.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledWith(A));
    expect(f.report).toHaveBeenCalledWith(
      "the web browser did not finish restarting; starting it again",
    );
  });
});

describe("a web browser that keeps failing to start", () => {
  const attempts = RETRY_MS.length + 1;
  const giveUp = async (f: ReturnType<typeof fixture>) => {
    f.start.mockRejectedValue(new Error("Browser start failed during readiness"));
    warm(f.deps);
    for (const delay of RETRY_MS) await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(attempts));
  };

  it("is given up after a bounded number of attempts, and the task is told once", async () => {
    vi.setSystemTime(Date.parse("2026-10-29T08:00:00.000Z"));
    const f = fixture();
    await giveUp(f);
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.start).toHaveBeenCalledTimes(attempts);
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]?.[0]).toBe(A);
    expect(f.notify.mock.calls[0]?.[1]).toMatch(
      /could not be started after 6 attempts over about 2 minutes \(Browser start failed during readiness\).*stopped trying by itself.*restart: true/u,
    );
    expect(f.noteRetry.mock.calls.slice(0, 2)).toEqual([
      [A, new Date(Date.parse("2026-10-29T08:00:00.000Z") + 2000)],
      [A, new Date(Date.parse("2026-10-29T08:00:02.000Z") + 5000)],
    ]);
    expect(f.noteRetry).toHaveBeenLastCalledWith(A, undefined);
    expect(f.report).toHaveBeenLastCalledWith(
      "the web browser couldn't start: Browser start failed during readiness; gave up after 6 attempts",
    );
  });

  it("gets a fresh round when what stopped it changes", async () => {
    const f = fixture();
    f.start.mockRejectedValue(new Error("docker busy"));
    const warmer = warm(f.deps);
    for (const delay of RETRY_MS) await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(attempts));
    f.start.mockClear();
    warmer.reset();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.start.mockClear();
    for (const delay of RETRY_MS) await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(RETRY_MS.length));
    f.set(cell(A, { state: "stopped" }));
    f.start.mockClear();
    f.start.mockImplementation(async (parent: string) => {
      f.restartBrowser(parent);
      return { parentCellId: parent } as ReadyBrowser;
    });
    f.set(cell(A));
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  });

  it("doesn't count a start that something else took over", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(new BrowserStartCancelled());
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    expect(f.noteProblem).not.toHaveBeenCalled();
    expect(f.noteRetry).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("marks a browser it restarts as missed, so the task hears when it is back", async () => {
    const f = fixture();
    warm(f.deps);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    f.health.mockResolvedValueOnce("unready");
    await vi.advanceTimersByTimeAsync(WARM_SWEEP_MS);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    expect(f.noteOutage).toHaveBeenCalledWith(A);
    expect(f.noteOutage.mock.invocationCallOrder[0]).toBeLessThan(
      f.stop.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
