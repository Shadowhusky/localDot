import { memoryUndoEligible } from "./activity.ts";
import type { AgentChange } from "./model.ts";

export type UndoStatus = "ready" | "pending" | "conflict" | "uncertain" | "failed" | "undone";
// Mutation ownership lives in the controller; these callbacks always name this durable change.
export function MemoryCard({
  change,
  changes,
  onInspect,
  onUndo,
  onReread,
  status = "ready",
}: {
  change: AgentChange;
  changes: readonly AgentChange[];
  onInspect: (trigger: HTMLButtonElement) => void;
  onUndo?: (changeId: string) => void;
  onReread?: () => void;
  status?: UndoStatus;
}) {
  const eligible = status !== "undone" && memoryUndoEligible(change, changes);
  return (
    <section className="memory-card" aria-label="Memory change">
      <div className="activity-heading">
        <h3>{change.undoes ? "Memory undo" : "Memory updated"}</h3>
        <span>{change.path}</span>
      </div>
      <p>
        {change.undoes
          ? "A recorded change was undone."
          : "Inspect the recorded diff before choosing whether to undo it."}
      </p>
      <button type="button" onClick={(event) => onInspect(event.currentTarget)}>
        Inspect memory diff
      </button>
      {eligible && (
        <button
          type="button"
          disabled={!onUndo || status !== "ready"}
          onClick={() => {
            if (onUndo && change.changeId && status === "ready") onUndo(change.changeId);
          }}
        >
          Undo this change
        </button>
      )}
      {!eligible && !change.undoes && (
        <p className="history-note">
          {change.changeId
            ? "This change has already been undone."
            : "No durable undo ID is available for this change."}
        </p>
      )}
      {status === "pending" && <p role="status">Undo requested. Checking the recorded change…</p>}
      {status === "conflict" && (
        <p role="status">Memory changed since this update. Reread it before deciding what to do.</p>
      )}
      {status === "uncertain" && (
        <p role="status">
          Undo delivery not confirmed. Reread memory and task history before trying again.
        </p>
      )}
      {status === "failed" && (
        <p role="status">The change could not be undone. Reread memory to check it.</p>
      )}
      {(status === "conflict" || status === "uncertain" || status === "failed") && onReread && (
        <button type="button" onClick={onReread}>
          Reread memory
        </button>
      )}
    </section>
  );
}
