import { Button } from "../ui/Button.tsx";
import { ActivityRow } from "./ActivityRow.tsx";
import { changeView, memoryUndoEligible } from "./activity.ts";
import { DiffViewer } from "./DiffViewer.tsx";
import type { AgentChange } from "./model.ts";

export type UndoStatus = "ready" | "pending" | "conflict" | "uncertain" | "failed" | "undone";

const STATUS: Partial<Record<UndoStatus, string>> = {
  pending: "Undoing this change…",
  conflict: "Memory changed since this update. Read it again before deciding.",
  uncertain: "The undo wasn't confirmed. Read memory and the task history before trying again.",
  failed: "This change couldn't be undone. Read memory to check it.",
};

// A change no step row holds: a memory update (with Undo) or a file changed outside a step.
// Mutation ownership lives in the controller; these callbacks always name this durable change.
export function ChangeRow({
  id,
  change,
  changes,
  open,
  onToggle,
  onUndo,
  onReread,
  status = "ready",
}: {
  id: string;
  change: AgentChange;
  changes: readonly AgentChange[];
  open: boolean;
  onToggle(trigger: HTMLButtonElement): void;
  onUndo?: (changeId: string) => void;
  onReread?: () => void;
  status?: UndoStatus;
}) {
  const memory = change.type === "memory";
  const eligible = status !== "undone" && memoryUndoEligible(change, changes);
  const message = STATUS[status];
  return (
    <ActivityRow id={id} view={changeView(change)} open={open} onToggle={onToggle}>
      <div className="activity-detail">
        <DiffViewer change={change} compact />
        {memory && !change.undoes && (
          <div className="activity-detail-actions">
            {eligible ? (
              <Button
                size="sm"
                disabledReason={
                  !onUndo
                    ? "Undo isn't available while dot is waiting on you or the computer is busy."
                    : status !== "ready"
                      ? (message ?? "Undo isn't available right now.")
                      : undefined
                }
                onClick={() => {
                  if (onUndo && change.changeId && status === "ready") onUndo(change.changeId);
                }}
              >
                Undo this change
              </Button>
            ) : (
              <p className="activity-detail-note">
                {change.changeId
                  ? "This change has already been undone."
                  : "This change can't be undone."}
              </p>
            )}
            {(status === "conflict" || status === "uncertain" || status === "failed") &&
              onReread && (
                <Button variant="quiet" size="sm" onClick={onReread}>
                  Read memory again
                </Button>
              )}
          </div>
        )}
        {memory && (
          <p role="status" className="activity-detail-note">
            {message}
          </p>
        )}
      </div>
    </ActivityRow>
  );
}
