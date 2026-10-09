import type { Rect } from "@localdot/protocol";
import type { ActionState, SessionModel } from "@localdot/stage";
import { past, progressive } from "./status.ts";

export interface StepRowView {
  id: string;
  label: string;
  verb?: string;
  startT: number;
  status: "doing" | "ok" | "failed" | "cancelled";
  frameId?: string;
  target?: Rect;
  durationMs: number | null;
  delivery?: "proposed" | "delivered";
  reason?: string;
  // Where it happened and the gesture with what it touched: "Calc", "click F3".
  app?: string;
  gesture?: string;
}

const COUNTS = ["", "", "double-", "triple-"];

function gesture(a: ActionState): string {
  const input = a.dispatch?.input;
  const word =
    input?.kind === "click"
      ? `${input.button === "right" ? "right-" : input.button === "middle" ? "middle-" : COUNTS[input.count]}click`
      : a.verb === "key"
        ? "keys"
        : a.verb;
  return a.target?.name ? `${word} ${a.target.name}` : word;
}

const CANCEL_REASONS: Record<string, string> = {
  preflight: "The action was refused before input.",
  policy: "The action was blocked by policy.",
  user: "Cancelled by you.",
  model: "Cancelled by the agent.",
  timeout: "The action timed out.",
  stale: "The target changed before input.",
};
// A cancel after the input was delivered: a drag that pressed, then was cancelled before its drop.
const DROP_CANCEL_REASONS: Record<string, string> = {
  user: "Stopped before the drop. The drag was cancelled.",
  stale: "Another window was at the drop point. The drag was cancelled.",
};

export function stepRows(model: SessionModel): StepRowView[] {
  const rows = new Map<string, StepRowView>();
  const stepOf = (a: ActionState) => a.step ?? a.id;
  for (const a of model.actions) {
    const id = stepOf(a);
    const done = a.resultT ?? a.cancel?.t;
    const status: StepRowView["status"] = a.cancel
      ? a.cancel.reason === "user"
        ? "cancelled"
        : "failed"
      : a.resultT === undefined
        ? "doing"
        : a.ok
          ? "ok"
          : "failed";
    rows.set(id, {
      id,
      startT: rows.get(id)?.startT ?? a.intentT,
      verb: a.verb,
      // Past tense only for a step that finished: a delivered one that failed or was stopped
      // part-way says what it tried.
      label:
        done === undefined
          ? progressive(a.label)
          : status === "ok" && (a.dispatch || a.verb === "wait")
            ? past(a.label)
            : a.label,
      status,
      ...(a.target?.bbox ? { target: a.target.bbox } : {}),
      durationMs: done === undefined ? null : Math.round(done - a.intentT),
      delivery: a.dispatch ? "delivered" : "proposed",
      gesture: gesture(a),
      ...(a.target?.app ? { app: a.target.app } : {}),
      ...(a.cancel
        ? {
            reason:
              (a.dispatch ? DROP_CANCEL_REASONS[a.cancel.reason] : undefined) ??
              CANCEL_REASONS[a.cancel.reason] ??
              "The action was cancelled.",
          }
        : {}),
    });
  }
  // The frame a step ends with is the observe appended inside it; the model keeps observes by
  // step through the actions' order: the latest observe at or before the result belongs to it.
  return [...rows.values()].map((row) => ({
    ...row,
    ...(frameFor(model, row.id) ? { frameId: frameFor(model, row.id) } : {}),
  }));
}

function frameFor(model: SessionModel, step: string): string | undefined {
  return model.frames?.get(step);
}
