import type { AgentSession, ManualLease, ToolLease } from "../agent/session.ts";
import type { Transfers } from "../agent/transfers.ts";
import type { CellSummary, DesktopdEndpoint } from "../cells/types.ts";
import type { QuarantineAccess } from "./quarantine-routes.ts";

export interface QuarantineAccessDeps {
  available(): boolean;
  cell(id: string): CellSummary | undefined;
  endpoint(id: string): DesktopdEndpoint | undefined;
  session(id: string): AgentSession | undefined;
  busy(id: string): boolean;
  transfers: Transfers;
}

// Explicit user file release participates in the same task/manual and transfer
// drains as other computer effects. A task is not required for an idle computer.
export function quarantineAccess(
  deps: QuarantineAccessDeps,
  id: string,
  signal: AbortSignal,
): QuarantineAccess | undefined {
  const endpoint = deps.endpoint(id);
  if (!endpoint || !deps.cell(id)) return undefined;
  const pinned = { ...endpoint };
  const session = deps.session(id);
  const generation = session?.generation;
  let action: ToolLease | ManualLease | undefined;
  let cutBy: AbortSignal | undefined;
  const check = () => {
    signal.throwIfAborted();
    const cell = deps.cell(id),
      current = deps.endpoint(id);
    if (
      !deps.available() ||
      cell?.state !== "ready" ||
      cell.paused ||
      cell.fenced ||
      cell.replacementPending ||
      deps.busy(id) ||
      current?.baseUrl !== pinned.baseUrl ||
      current.token !== pinned.token ||
      deps.session(id) !== session ||
      session?.stopped
    )
      throw new Error("The computer changed during the file release.");
    action?.check();
    if (
      session &&
      !action &&
      (session.generation !== generation || session.controlHeld || session.status !== "idle")
    )
      throw new Error("The task is not ready for a file release.");
  };
  // Admission selects the actual current control owner, rather than using an
  // agent permit during takeover or holding a stale browser download permit.
  if (session?.controlHeld) {
    const request = session.pendingTakeover;
    if (!request) return undefined;
    const manual = session.admitManual(request, signal);
    action = manual;
    // A hand-back does not wait for a file still on its way: it stops it.
    cutBy = manual.returning;
  } else if (session && generation) {
    action = session.admit(generation, signal);
    cutBy = action.signal;
  }
  try {
    check();
    const transfer = deps.transfers.acquire(
      id,
      [signal, ...(cutBy ? [cutBy] : session ? [session.abort.signal] : [])],
      check,
    );
    return {
      signal: transfer.signal,
      check: transfer.check,
      release() {
        transfer.release();
        action?.finish();
      },
    };
  } catch (error) {
    action?.finish();
    throw error;
  }
}
