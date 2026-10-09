import type { PauseSnapshot, Rect } from "@localdot/protocol";
import type { Status } from "../session/status.ts";

// The island's fixed shapes; within one, its width never changes. Ready: the computer is on and
// free. Task: a task holds it, with every slot. Control: the user has the computer, and Hand back
// stands where Take control was. Computer: the computer is off, starting or stuck, with the
// computer's own action until the curtain carries it. Hidden: the curtain covers the stage, or
// nothing is known yet.
export type IslandShape = "hidden" | "ready" | "task" | "control" | "computer";

const ON = new Set<Status["computer"]>(["live", "connecting", "reconnecting"]);

export function islandShape(status: Status, curtain: boolean): IslandShape {
  if (curtain || status.computer === "checking") return "hidden";
  if (status.row === "control") return "control";
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
        reason: handedOver
          ? "You have the computer"
          : budgetHeld
            ? "Raise this task's limit first"
            : "Continue isn't available yet",
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
  busy?: boolean;
}

export interface TakeInput {
  decision?: IslandDecision;
  // Why the user can't take the computer just now, or nothing when they can.
  blocked?: string;
  // The computer is on its way to the user.
  taking?: boolean;
}

export interface TakeReasonInput {
  // A task is live on the computer, so the user takes its control; otherwise a hold of their own.
  task: boolean;
  ready: boolean;
  pause: PauseSnapshot["phase"] | undefined;
}

// Why the user can't take the computer just now, or nothing when they can. A Pause that can't be
// confirmed never settles by itself: only Stop ends it.
export function takeReason({ task, ready, pause }: TakeReasonInput): string | undefined {
  if (ready) return undefined;
  if (!task) return "Wait for the computer to be ready";
  if (pause === "uncertain") return "Stop the task to take over";
  if (pause && pause !== "paused") return "Wait for the pause to settle";
  return "Wait a moment";
}

// Take control works whatever dot is doing. dot handing the computer over makes it the porcelain
// action; while dot waits on an approval it answers that approval: the user does the step
// themselves.
export function takeSlot(status: Status, { decision = null, blocked, taking }: TakeInput = {}) {
  if (status.row === "takeover") return { primary: true } satisfies TakeSlot;
  if (decision === "approval") return { primary: false } satisfies TakeSlot;
  if (taking) return { primary: false, busy: true } satisfies TakeSlot;
  return { primary: false, ...(blocked ? { reason: blocked } : {}) } satisfies TakeSlot;
}

// The space the decision keeps from a ring on a field dot will fill.
const RING_CLEARANCE_PX = 12;

export interface DecisionPlace {
  // The decision's top while it hangs from the stage's top edge, in the stage's px.
  hung: number;
  size: { w: number; h: number };
  stageW: number;
  // The rings on the fields dot will fill, in the stage's px.
  rings: readonly Rect[];
  // How low the decision's foot may reach before it leaves the page.
  floor: number;
}

// Where the decision's top sits: hung from the stage's top edge, or, when it would cover a ring on a
// field dot will fill, just under that ring, as far as the page has room. The stage never moves.
export function decisionTop({ hung, size, stageW, rings, floor }: DecisionPlace): number {
  const left = (stageW - size.w) / 2;
  let top = hung;
  for (const ring of [...rings].sort((a, b) => a.y - b.y)) {
    const covered =
      ring.x - RING_CLEARANCE_PX < left + size.w &&
      ring.x + ring.w + RING_CLEARANCE_PX > left &&
      ring.y - RING_CLEARANCE_PX < top + size.h &&
      ring.y + ring.h + RING_CLEARANCE_PX > top;
    if (covered) top = ring.y + ring.h + RING_CLEARANCE_PX;
  }
  return Math.max(hung, Math.min(top, floor - size.h));
}
