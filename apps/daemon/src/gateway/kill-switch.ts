import { CellControlConflict, type CellOrchestrator } from "../cells/orchestrator.ts";
import type { CellKeyd } from "../keyd/cell-wiring.ts";
import type { LiveSessions } from "./live.ts";

export interface KillSwitchDeps {
  live: Pick<LiveSessions, "cellOf" | "stop" | "settled">;
  keyd: Pick<CellKeyd, "revoke" | "refresh" | "isWired" | "close">;
  cells: Pick<CellOrchestrator, "get" | "record" | "withLifecycle">;
  settleMs?: number;
}

export interface StopOutcome {
  revoked: boolean;
  paused: boolean;
  closed: boolean;
  stopped: boolean;
  errors: string[];
}

// Abort work immediately, then revoke, drain and freeze in the cell's lifecycle
// queue. If freezing fails, close egress and stop both containers in that queue.
export class KillSwitch {
  readonly #settleMs: number;
  readonly #busy = new Map<string, number>();
  readonly #stops = new Map<string, Promise<StopOutcome>>();

  constructor(private readonly deps: KillSwitchDeps) {
    this.#settleMs = deps.settleMs ?? 4000;
  }

  isBusy(cellId: string): boolean {
    return this.#busy.has(cellId);
  }

  stopSession(sessionId: string): Promise<StopOutcome | undefined> {
    const existing = this.#stops.get(sessionId);
    if (existing) return existing;
    const { live, keyd, cells } = this.deps;
    const cellId = live.cellOf(sessionId);
    if (!cellId) return Promise.resolve(undefined);
    const settled = live.settled(sessionId);
    live.stop(sessionId);
    const stopped = this.#track(cellId, () => {
      const errors: string[] = [];
      const attempt = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          return true;
        } catch {
          // Docker/keyd exceptions can contain untrusted request contents.
          const error = `${what}: could not confirm completion`;
          if (!errors.includes(error)) errors.push(error);
          return false;
        }
      };
      // Cut off upstream requests now, even if an earlier Start is waiting on
      // Docker. Enqueue the freeze without awaiting this network operation.
      const immediateRevoke = attempt("keyd", () => keyd.revoke(cellId));
      return cells.withLifecycle(cellId, async (controls) => {
        let revoked = await immediateRevoke;
        // Earlier lifecycle work can finish wiring after the first revoke.
        // Fence that newly issued material before freezing or closing the cell.
        if (controls.waitedForOperation) revoked = await attempt("keyd", () => keyd.revoke(cellId));
        await settleWithin(settled, this.#settleMs);
        const paused = await attempt("pause", () => controls.pause());
        const closed = !paused && (await attempt("keyd close", () => keyd.close(cellId)));
        const stopped = !paused && (await attempt("stop", () => controls.stop()));
        return { revoked, paused, closed, stopped, errors };
      });
    }).finally(() => this.#stops.delete(sessionId));
    this.#stops.set(sessionId, stopped);
    return stopped;
  }

  resume(cellId: string): Promise<void> {
    const { keyd, cells } = this.deps;
    return this.#track(cellId, () =>
      cells.withLifecycle(cellId, async (controls) => {
        const cell = cells.get(cellId);
        const record = cells.record(cellId);
        if (cell?.fenced || cell?.replacementPending)
          throw new CellControlConflict(
            "the computer is fenced or awaiting replacement confirmation",
          );
        if (!cell?.paused || cell.state !== "ready" || !record) {
          throw new CellControlConflict("the computer must be ready and paused before resuming");
        }
        // Stop's earlier revoke may have failed. Refresh the archive while all
        // processes are still frozen; a failed refresh must never thaw them.
        await keyd.revoke(cellId);
        if (await keyd.isWired(record)) {
          await keyd.refresh(record);
          await controls.unpause();
        } else {
          // Start stops the old frozen desktop before wiring a new listener/CA.
          // Never briefly thaw old processes with obsolete key material.
          await controls.start();
        }
      }),
    );
  }

  async #track<T>(cellId: string, work: () => Promise<T>): Promise<T> {
    this.#busy.set(cellId, (this.#busy.get(cellId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const remaining = (this.#busy.get(cellId) ?? 1) - 1;
      if (remaining) this.#busy.set(cellId, remaining);
      else this.#busy.delete(cellId);
    }
  }
}

function settleWithin(settled: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    void settled.then(done, done);
  });
}
