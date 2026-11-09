import {
  COMPUTER_UPDATE_STAGES,
  type ComputerUpdateStage,
} from "../../../../packages/protocol/src/computer-operation.ts";

export const COMPUTER_STAGE_NAMES: Record<ComputerUpdateStage, string> = {
  download: "Get the new version",
  stop: "Stop your computer",
  keep: "Keep your apps and files",
  replace: "Install the new version",
  start: "Start your computer",
  reconnect: "Reconnect the screen",
};

const STAGE_WORDS: Record<ComputerUpdateStage, string> = {
  download: "Getting the new version",
  stop: "Stopping your computer",
  keep: "Keeping your apps and files",
  replace: "Installing the new version",
  start: "Starting your computer",
  reconnect: "Reconnecting the screen",
};

export const stageLine = (stage: ComputerUpdateStage, detail?: string) => {
  const at = COMPUTER_UPDATE_STAGES.indexOf(stage) + 1;
  return `Step ${at} of ${COMPUTER_UPDATE_STAGES.length} · ${detail ?? STAGE_WORDS[stage]}`;
};

// How far along the whole update is. No stage's end is passed before that stage has ended, however
// long it takes, so a long one waits at its own place on the bar instead of nearly at the end.
export function stageBounds(stage: ComputerUpdateStage, share = 0): [number, number] {
  const at = COMPUTER_UPDATE_STAGES.indexOf(stage),
    each = 1 / COMPUTER_UPDATE_STAGES.length;
  return [(at + Math.min(1, share)) * each, (at + 1) * each];
}

export const SLOW_NOTE =
  "This is taking longer than usual, which is normal for a computer with many apps.";
export const STUCK_NOTE =
  "This is taking much longer than it should. Your files are kept. If it doesn't finish soon, restart localDot.";
const SLOW_MS = 3 * 60_000;
const STUCK_MS = 30 * 60_000;

// How long an update has been going, against how long one takes on this computer.
export function waitNote(elapsedMs: number, expectedMs: number): string | null {
  if (elapsedMs >= STUCK_MS) return STUCK_NOTE;
  return elapsedMs >= Math.max(SLOW_MS, 3 * expectedMs) ? SLOW_NOTE : null;
}
