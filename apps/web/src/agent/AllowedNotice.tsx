import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { allowedLine, undoAllowedLabel } from "../copy/autonomy.ts";
import { Button } from "../ui/Button.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { markdownToPlain } from "./markdown.ts";
import type { ApprovalOutcome } from "./model.ts";
import type { AllowedChoice } from "./useSafety.ts";

const SHOWN_MS = 8000;
const LEAVE_MS = 180;
// What an Always allow choice now allows, with Undo, dropped from the island. Mounted for as long
// as the task view is, so its live region exists before a line arrives.
export function AllowedNotice({
  choice,
  outcome,
  visible,
  onUndo,
  onDismiss,
}: {
  choice: AllowedChoice | null;
  outcome: ApprovalOutcome | undefined;
  visible: boolean;
  onUndo(): void;
  onDismiss(): void;
}) {
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const [leaving, setLeaving] = useState(false);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  });
  const confirmed =
    choice && outcome?.approvalId === choice.approvalId && outcome.decision === "approve"
      ? outcome
      : undefined;
  const saved = !!choice && confirmed?.rule?.scope === choice.option.scope;
  const undone = choice?.undo === "done" || !!confirmed?.ruleRemoved;
  const text = saved
    ? undone
      ? "Undone. You'll be asked again next time."
      : allowedLine(choice.actionClass, choice.option)
    : confirmed?.note
      ? markdownToPlain(confirmed.note)
      : null;
  const undoable = saved && !undone;
  const failed = undoable && choice.undo === "failed" ? " Couldn't undo. Try again." : "";
  // A removed or hidden Undo never reports pointer-leave or blur.
  const reachable = visible && undoable;
  useEffect(() => {
    if (!reachable) setHeld({ pointer: false, focus: false });
  }, [reachable]);
  const waiting = reachable && (held.pointer || held.focus);
  useEffect(() => {
    if (!text || waiting) return;
    setLeaving(false);
    const leave = setTimeout(() => setLeaving(true), SHOWN_MS);
    const gone = setTimeout(() => dismiss.current(), SHOWN_MS + LEAVE_MS);
    return () => {
      clearTimeout(leave);
      clearTimeout(gone);
    };
  }, [text, waiting]);
  const shown = visible && text;
  return (
    <>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {shown ? `${text}${failed}` : ""}
      </VisuallyHidden>
      {shown && (
        <div
          className={leaving ? "island-note always-notice leaving" : "island-note always-notice"}
        >
          <p aria-hidden="true">
            {text}
            {failed}
          </p>
          {undoable && (
            <Button
              variant="quiet"
              size="sm"
              aria-label={undoAllowedLabel(choice.actionClass, choice.option)}
              busy={choice.undo === "pending"}
              onClick={onUndo}
              onPointerEnter={() => setHeld((old) => ({ ...old, pointer: true }))}
              onPointerLeave={() => setHeld((old) => ({ ...old, pointer: false }))}
              onFocus={() => setHeld((old) => ({ ...old, focus: true }))}
              onBlur={() => setHeld((old) => ({ ...old, focus: false }))}
            >
              Undo
            </Button>
          )}
        </div>
      )}
    </>
  );
}
