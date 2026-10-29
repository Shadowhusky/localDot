import type { BrowserBlock } from "../cells/browser-orchestrator.ts";
import type { BrowserRecovery } from "../cells/browser-recovery.ts";
import type { CellOrchestrator } from "../cells/orchestrator.ts";
import type { KeydHealth } from "../keyd/monitor.ts";

export interface BrowserAdmission {
  shuttingDown(): boolean;
  keyd(): Pick<KeydHealth, "online" | "audit">;
  recovery: Pick<BrowserRecovery, "available" | "pending">;
  cells: Pick<CellOrchestrator, "get" | "browserPending">;
}

const AGAIN = "Nothing: localDot tries again by itself.";

// Why a computer's web browser can't run now, in the order the user would have to clear it: the
// daemon, keyd, the computer, then the confirmation that the previous browser is gone.
export function browserBlock(
  deps: BrowserAdmission,
  parentCellId: string,
): BrowserBlock | undefined {
  if (deps.shuttingDown())
    return {
      reason: "shutting-down",
      problem: "localDot is shutting down.",
      clears: "localDot starting again.",
    };
  const keyd = deps.keyd();
  if (!keyd.online)
    return {
      reason: "key-service-offline",
      problem:
        "localDot's key service isn't answering, and the web browser needs it for its network access.",
      clears:
        "The key service running again (it restarts by itself; localdot doctor checks it). The web browser then starts by itself.",
    };
  if (keyd.audit?.ok !== true)
    return {
      reason: "key-service-offline",
      problem:
        "localDot's key service can't write its audit log, so it lets no browser traffic through.",
      clears:
        "Free disk space on this machine (localdot doctor shows the key service's state). The web browser then starts by itself.",
    };
  const cell = deps.cells.get(parentCellId);
  if (cell?.paused)
    return {
      reason: "computer-paused",
      problem: "The computer is frozen by Stop.",
      clears: "Resume the computer; the web browser then starts by itself.",
    };
  if (cell?.state !== "ready" || cell.fenced || cell.replacementPending)
    return cell?.state === "starting"
      ? {
          reason: "computer-stopped",
          problem: "The computer is starting.",
          clears: "Nothing: the web browser starts once the computer is ready.",
        }
      : {
          reason: "computer-stopped",
          problem: "The computer is not running.",
          clears: "Start the computer; the web browser starts with it.",
        };
  if (!deps.recovery.available) {
    const { failure, retryAt } = deps.recovery.pending;
    return {
      reason: "recovering",
      problem: failure
        ? `localDot couldn't yet confirm that the previous web browser stopped (${failure}).`
        : "localDot is making sure the previous web browser has stopped before starting it again.",
      clears: AGAIN,
      ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
    };
  }
  const pending = deps.cells.browserPending(parentCellId);
  if (pending)
    return {
      reason: "recovering",
      problem:
        pending === "unconfirmed"
          ? "localDot couldn't yet confirm that the computer's previous web browser stopped (the key service or Docker didn't answer)."
          : "The computer's previous web browser is being stopped.",
      clears: AGAIN,
    };
  return undefined;
}
