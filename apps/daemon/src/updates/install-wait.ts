import type { LiveSessions } from "../gateway/live.ts";

export interface InstallWaitDeps {
  cells: { list(): readonly { id: string; operation?: unknown }[] };
  live: Pick<LiveSessions, "get" | "idleOperationPending">;
  runner: {
    holds(sessionId: string): boolean;
    get(sessionId: string): { status: string; controlHeld: boolean } | undefined;
    release?(signal?: AbortSignal, sessionId?: string | null): Promise<void>;
  };
}

const BUSY = "Wait for dot to finish, or stop the task, then update localDot.";

// Installing restarts localDot: never while dot works or the user holds a computer. As for a
// computer's Update, a finished task's wait for a follow-up ends first; the conversation carries on.
export async function installRefusal(d: InstallWaitDeps): Promise<string | null> {
  for (const cell of d.cells.list()) {
    const sessionId = d.live.get(cell.id);
    if (!sessionId) continue;
    const session = d.runner.get(sessionId);
    if (d.runner.holds(sessionId) || session?.controlHeld)
      return "Hand back the computer first, then update localDot.";
    if (session?.status !== "idle" || !d.runner.release) return BUSY;
    try {
      await d.runner.release(undefined, sessionId);
    } catch {
      return BUSY;
    }
  }
  const cells = d.cells.list();
  if (cells.some((cell) => d.live.get(cell.id))) return BUSY;
  if (cells.some((cell) => d.live.idleOperationPending(cell.id) || cell.operation))
    return "Your computer is starting, stopping or updating. Try again in a minute.";
  return null;
}
