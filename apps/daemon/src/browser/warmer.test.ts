import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import type { CellState, CellSummary } from "../cells/types.ts";
import { BrowserWarmer, type BrowserWarmerDeps, WARM_SWEEP_MS } from "./warmer.ts";

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
  const running = new Set<string>();
  const states = new Map<string, CellState>();
  let holder: string | undefined;
  const start = vi.fn(async (parent: string) => {
    running.add(parent);
    holder = parent;
    return { parentCellId: parent } as ReadyBrowser;
  });
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
      endpoints: (parent) =>
        running.has(parent) ? ({ parentCellId: parent } as ReadyBrowser) : undefined,
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
  };
  return {
    deps,
    start,
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
      if (parent && live) running.add(parent);
      if (parent && state) states.set(parent, state);
    },
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
