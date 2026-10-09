import type { PauseSnapshot } from "@localdot/protocol";
import type { Status } from "../session/status.ts";

// The island's fixed shapes; within one, its width never changes. Ready: the computer is on and
// free. Task: a task holds it, with every slot. Computer: the computer is off, starting or stuck,
// with the computer's own action until the curtain carries it. Hidden: the curtain covers the
// stage, or nothing is known yet.
export type IslandShape = "hidden" | "ready" | "task" | "computer";

const ON = new Set<Status["computer"]>(["live", "connecting", "reconnecting"]);

export function islandShape(status: Status, curtain: boolean): IslandShape {
  if (curtain || status.computer === "checking") return "hidden";
  if (status.actions.some((action) => action.kind === "stop-task")) return "task";
  return ON.has(status.computer) ? "ready" : "computer";
}

// The amber point beside the label: dot needs the user, or is stuck until they act.
export const islandAttention = (status: Status) =>
  status.attention === "needs_you" || status.attention === "blocked";

export interface PauseSlot {
  kind: "pause" | "continue";
  // Unavailable while set; the button keeps its place and says why.
  reason?: string;
}

export interface PauseInput {
  pause: PauseSnapshot | null | undefined;
  canPause: boolean;
  canResume: boolean;
  // dot has handed the computer over, so there is nothing of dot's to pause.
  handedOver: boolean;
  // The task is held at its own spending limit until the limit is raised.
  budgetHeld?: boolean;
}

export function pauseSlot({
  pause,
  canPause,
  canResume,
  handedOver,
  budgetHeld = false,
}: PauseInput): PauseSlot {
  if (!pause) {
    if (canPause) return { kind: "pause" };
    return {
      kind: "pause",
      reason: handedOver ? "You have the computer" : "Pause isn't available right now",
    };
  }
  switch (pause.phase) {
    case "pausing":
      return { kind: "pause", reason: "Pausing after this step" };
    case "resuming":
      return { kind: "continue", reason: "Continuing" };
    case "uncertain":
      return { kind: "continue", reason: "The pause isn't confirmed. Stop the task instead." };
    case "paused":
      if (canResume) return { kind: "continue" };
      return {
        kind: "continue",
        reason: budgetHeld ? "Raise this task's limit first" : "Continue isn't available yet",
      };
  }
}

// What grows out of the island: an approval always, and a question while the chat that holds it
// is out of sight. A phone shows the approval in a sheet instead and keeps the question in its
// thread, which is always in sight there.
export type IslandDecision = "approval" | "question" | null;

export interface DecisionInput {
  shape: IslandShape;
  approval: boolean;
  question: boolean;
  chatShown: boolean;
}

export function islandDecision({
  shape,
  approval,
  question,
  chatShown,
}: DecisionInput): IslandDecision {
  if (shape !== "task") return null;
  if (approval) return "approval";
  return question && !chatShown ? "question" : null;
}

export interface TakeSlot {
  // dot has asked for the user: Take control becomes the island's porcelain action.
  primary: boolean;
  reason?: string;
}

// While dot waits on an approval, Take control answers it: the user does the step themselves.
export const takeSlot = (status: Status, decision: IslandDecision = null): TakeSlot =>
  status.row === "takeover"
    ? { primary: true }
    : decision === "approval"
      ? { primary: false }
      : { primary: false, reason: "dot hands you the computer when it needs you" };
