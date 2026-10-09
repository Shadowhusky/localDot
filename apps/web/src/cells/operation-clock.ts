import {
  COMPUTER_OPERATION_STEPS,
  type ComputerOperationKind,
  type ComputerOperationStep,
  EXPECTED_OPERATION_MS,
} from "@localdot/protocol";
import type { CellSummary } from "./types.ts";

// What a progress clock counts from, in this page's wall-clock ms.
export interface Timing {
  since: number;
  expectedMs: number;
  kind: ComputerOperationKind;
  step?: ComputerOperationStep;
}

// A computer's lifecycle operation on this page's clock. `since` comes from how long the daemon
// said it had run when its summary arrived, so a refresh, a second tab and a curtain shown again
// all count from the daemon's start, whatever this page's own clock says.
export interface OperationClock extends Timing {
  cellId: string;
  step: ComputerOperationStep;
  startedAt: number;
}

// The operation once a summary has arrived at `now`. One already known keeps its anchor, so later
// summaries never move its clock. While the computer is still on its way, a summary without one,
// or none at all (it couldn't be read, or the connection dropped), keeps the last.
export function followOperation(
  last: OperationClock | null,
  cell: CellSummary | null,
  now: number,
): OperationClock | null {
  if (!cell) return last;
  const op = cell.operation;
  if (!op) return last?.cellId === cell.id && underway(cell) ? last : null;
  if (last?.cellId === cell.id && last.startedAt === op.startedAt && last.kind === op.kind) {
    const step = later(last.step, op.step);
    return step === last.step && op.expectedMs === last.expectedMs
      ? last
      : { ...last, step, expectedMs: op.expectedMs };
  }
  return {
    cellId: cell.id,
    kind: op.kind,
    step: op.step,
    startedAt: op.startedAt,
    since: now - op.elapsedMs,
    expectedMs: op.expectedMs,
  };
}

const underway = (cell: CellSummary) =>
  cell.state === "starting" ||
  cell.state === "stopping" ||
  (cell.state === "ready" && !cell.paused && cell.stream.connection !== "live");

const later = (a: ComputerOperationStep, b: ComputerOperationStep) =>
  COMPUTER_OPERATION_STEPS.indexOf(b) > COMPUTER_OPERATION_STEPS.indexOf(a) ? b : a;

export const expectedMsFor = (kind: ComputerOperationKind) =>
  EXPECTED_OPERATION_MS[kind === "restart" ? "start" : kind];

// The bar eases toward this over about the expected time and never reaches it: only the computer
// coming up fills it.
export const PROGRESS_HOLD = 0.95;

// Where a step puts the bar at least, so one the computer reached sooner than usual moves it on.
type Nudges = Partial<Record<ComputerOperationStep, number>>;
const START_NUDGES: Nudges = { desktop: 0.05, ready: 0.1, screen: 0.9 };
const UPDATE_NUDGES: Nudges = {
  install: 0.1,
  network: 0.2,
  desktop: 0.25,
  ready: 0.3,
  screen: 0.9,
};

// Nearly in step with the time at first, slowing as the expected time runs out.
export function progressAt({ since, expectedMs, kind, step }: Timing, now: number): number {
  const eased = PROGRESS_HOLD * Math.tanh((1.25 * Math.max(0, now - since)) / expectedMs);
  const nudges = kind === "update" ? UPDATE_NUDGES : kind === "stop" ? {} : START_NUDGES;
  return Math.min(PROGRESS_HOLD, Math.max(eased, (step && nudges[step]) ?? 0));
}
