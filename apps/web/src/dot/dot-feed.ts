import { type SessionModel, startedCount } from "@localdot/stage";
import type { Status, StatusRow } from "../session/status.ts";
import type { Point } from "./engine/engine.ts";
import type { DotState } from "./engine/states.ts";

// What drives the one live dot: its state, the xenon rim, the attention mark and where its work is.
export interface DotFeed {
  state: DotState;
  control: boolean;
  // dot needs the user: an approval, a question or a limit it can't pass.
  attention: boolean;
  // The action point on the picture, as fractions of the stage's width and height.
  focus: Point | null;
  // The action whose input has gone to the computer, for the nod that goes with it.
  dispatched: string | null;
  // The task has just finished well.
  done: boolean;
  // Changes when dot should blink that it heard, as each setup step arrives.
  nod?: string;
}

const ATTENTION = new Set<StatusRow>(["approval", "question", "waiting", "recovery", "limit"]);

export function dotFeed(
  status: Pick<Status, "dotPose" | "control" | "row">,
  model: SessionModel | null,
  nowMs: number,
): DotFeed {
  const action = model ? currentAction(model, nowMs) : undefined;
  // An action that waits on the computer (a page load, a download) is watched, not acted out.
  const state =
    status.dotPose === "acting" && action?.verb === "wait" ? "watching" : status.dotPose;
  const screen = model?.screen;
  const point = action?.target?.point ?? action?.point;
  return {
    state,
    control: status.control,
    attention: ATTENTION.has(status.row),
    focus:
      point && screen && screen.w > 0 && screen.h > 0
        ? { x: point.x / screen.w, y: point.y / screen.h }
        : null,
    dispatched: action?.dispatch ? action.id : null,
    done: status.row === "done",
  };
}

function currentAction(model: SessionModel, nowMs: number) {
  const n = startedCount(model, nowMs);
  return n > 0 ? model.actions[n - 1] : undefined;
}

// A line dot says for about as long as it would take to say it.
export const sayMs = (line: string) =>
  Math.min(2200, Math.max(500, line.trim().split(/\s+/).length * 170));
