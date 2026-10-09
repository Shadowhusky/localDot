import { CellControlConflict, type CellOrchestrator } from "../cells/orchestrator.ts";
import type { CellKeyd } from "../keyd/cell-wiring.ts";
import type { LiveSessions } from "./live.ts";

export interface KillSwitchDeps {
  live: Pick<LiveSessions, "cellOf" | "stop" | "settled" | "get">;
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

  // Session cleanup may await the exact Stop already containing its computer.
  // The receipt exists before abort listeners run, so they cannot race a second
  // physical stop against this operation's freeze/resume path.
  pendingStop(sessionId: string): Promise<StopOutcome> | undefined {
    return this.#stops.get(sessionId);
  }

  stopSession(sessionId: string): Promise<StopOutcome | undefined> {
    const existing = this.#stops.get(sessionId);
    if (existing) return existing;
    const { live } = this.deps;
    const cellId = live.cellOf(sessionId);
    if (!cellId) return Promise.resolve(undefined);
    const settled = live.settled(sessionId);
    const completion = Promise.withResolvers<StopOutcome>();
    const stopped = completion.promise;
    this.#stops.set(sessionId, stopped);
    const work = this.#track(cellId, () => {
      live.stop(sessionId);
      return this.#freeze(cellId, settled);
    });
    void work.then(
      (outcome) => {
        this.#stops.delete(sessionId);
        completion.resolve(outcome);
      },
      (error) => {
        this.#stops.delete(sessionId);
        completion.reject(error);
      },
    );
    return stopped;
  }

  // Stop everything also freezes a computer with no task: revoke, then pause in its lifecycle
  // queue. Undefined when it is not ready, already frozen, or gone.
  stopIdleCell(cellId: string): Promise<StopOutcome | undefined> {
    const sessionId = this.deps.live.get(cellId);
    if (sessionId) return this.stopSession(sessionId);
    const cell = this.deps.cells.get(cellId);
    if (cell?.state !== "ready" || cell.paused) return Promise.resolve(undefined);
    return this.#track(cellId, () => this.#freeze(cellId, undefined));
  }

  #freeze(cellId: string, settled: Promise<void> | undefined): Promise<StopOutcome> {
    const { keyd, cells } = this.deps;
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
      if (settled) await settleWithin(settled, this.#settleMs);
      const paused = await attempt("pause", () => controls.pause());
      const closed = !paused && (await attempt("keyd close", () => keyd.close(cellId)));
      const stopped = !paused && (await attempt("stop", () => controls.stop()));
      return { revoked, paused, closed, stopped, errors };
    });
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
