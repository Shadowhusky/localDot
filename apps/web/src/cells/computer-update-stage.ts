import {
  COMPUTER_UPDATE_STAGES,
  type ComputerUpdateStage,
} from "../../../../packages/protocol/src/computer-operation.ts";
import { t, tr } from "../i18n/index.ts";

export const COMPUTER_STAGE_NAMES: Record<ComputerUpdateStage, string> = {
  download: tr("Get the new version"),
  stop: tr("Stop your computer"),
  keep: tr("Keep your apps and files"),
  replace: tr("Install the new version"),
  start: tr("Start your computer"),
  reconnect: tr("Reconnect the screen"),
};

const STAGE_WORDS: Record<ComputerUpdateStage, string> = {
  download: tr("Getting the new version"),
  stop: tr("Stopping your computer"),
  keep: tr("Keeping your apps and files"),
  replace: tr("Installing the new version"),
  start: tr("Starting your computer"),
  reconnect: tr("Reconnecting the screen"),
};

export const stageLine = (stage: ComputerUpdateStage, detail?: string) => {
  const at = COMPUTER_UPDATE_STAGES.indexOf(stage) + 1;
  return t`Step ${at} of ${COMPUTER_UPDATE_STAGES.length} · ${detail ?? STAGE_WORDS[stage]}`;
};

// How far along the whole update is. No stage's end is passed before that stage has ended, however
// long it takes, so a long one waits at its own place on the bar instead of nearly at the end.
export function stageBounds(stage: ComputerUpdateStage, share = 0): [number, number] {
  const at = COMPUTER_UPDATE_STAGES.indexOf(stage),
    each = 1 / COMPUTER_UPDATE_STAGES.length;
  return [(at + Math.min(1, share)) * each, (at + 1) * each];
}

export const SLOW_NOTE = t`This is taking longer than usual, which is normal for a computer with many apps.`;
export const STUCK_NOTE = t`This is taking much longer than it should. Your files are kept. If it doesn't finish soon, restart localDot.`;
const SLOW_MS = 3 * 60_000;
const STUCK_MS = 30 * 60_000;

// How long an update has been going, against how long one takes on this computer.
export function waitNote(elapsedMs: number, expectedMs: number): string | null {
  if (elapsedMs >= STUCK_MS) return STUCK_NOTE;
  return elapsedMs >= Math.max(SLOW_MS, 3 * expectedMs) ? SLOW_NOTE : null;
}
