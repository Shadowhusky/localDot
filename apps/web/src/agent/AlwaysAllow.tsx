import {
  type ApprovalAnswer,
  type ApprovalCard as Card,
  ApprovalCard as CardSchema,
} from "@localdot/protocol";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { allowedLine, allowWithoutAsking, undoAllowedLabel } from "../copy/autonomy.ts";
import type { ApprovalOutcome } from "./model.ts";
import type { AllowedChoice } from "./useSafety.ts";

export function AlwaysAllow({
  card,
  canApprove,
  onDecision,
}: {
  card: Card;
  canApprove: boolean;
  onDecision(value: ApprovalAnswer): Promise<boolean> | boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const list = useId();
  useEffect(() => {
    if (!open) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panel.current?.scrollIntoView?.({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [open]);
  const value = CardSchema.safeParse(card);
  if (!value.success || !value.data.always?.length) return null;
  const { always, ...decided } = value.data;
  const choose = (scope: (typeof always)[number]["scope"]) => {
    if (!canApprove || Date.now() >= decided.expiresAt) return;
    void onDecision({
      approvalId: decided.approvalId,
      generation: decided.generation,
      revision: decided.revision,
      decision: "approve",
      always: scope,
    });
  };
  const close = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <div className="always-allow">
      <button
        ref={toggle}
        type="button"
        className="always-allow-toggle"
        aria-expanded={open}
        aria-controls={list}
        disabled={!canApprove}
        onClick={() => setOpen((old) => !old)}
        onKeyDown={close}
      >
        Always allow…
      </button>
      <fieldset ref={panel} id={list} className="always-allow-options" hidden={!open}>
        <legend>{allowWithoutAsking(decided.actionClass)}</legend>
        <div className="always-allow-choices">
          {always.map((option) => (
            <button
              key={option.scope}
              type="button"
              disabled={!canApprove}
              onClick={() => choose(option.scope)}
              onKeyDown={close}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

const SHOWN_MS = 8000;
const LEAVE_MS = 180;
// Mounted for as long as the task view is, so its live region exists before a line arrives.
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
    : (confirmed?.note ?? null);
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
  return createPortal(
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {shown ? `${text}${failed}` : ""}
      </span>
      {shown && (
        <div className={leaving ? "always-notice leaving" : "always-notice"}>
          <p aria-hidden="true">
            {text}
            {failed}
          </p>
          {undoable && (
            <button
              type="button"
              className="always-notice-undo"
              aria-label={undoAllowedLabel(choice.actionClass, choice.option)}
              disabled={choice.undo === "pending"}
              onClick={onUndo}
              onPointerEnter={() => setHeld((old) => ({ ...old, pointer: true }))}
              onPointerLeave={() => setHeld((old) => ({ ...old, pointer: false }))}
              onFocus={() => setHeld((old) => ({ ...old, focus: true }))}
              onBlur={() => setHeld((old) => ({ ...old, focus: false }))}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
