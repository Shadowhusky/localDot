import { z } from "zod";

// What the daemon is doing to a computer right now: what kind of operation, when it began and the
// step it is on, so every page counts from the daemon's start rather than from when it loaded.
export const ComputerOperationKind = z.enum(["first-start", "start", "restart", "update", "stop"]);
export type ComputerOperationKind = z.infer<typeof ComputerOperationKind>;

// In the order the daemon goes through them. An update first stops the old version and installs
// the new one; every start then prepares the network, starts the desktop and waits for it to be
// ready, and the viewer connects the screen last.
export const COMPUTER_OPERATION_STEPS = [
  "shutdown",
  "install",
  "network",
  "desktop",
  "ready",
  "screen",
] as const;
export const ComputerOperationStep = z.enum(COMPUTER_OPERATION_STEPS);
export type ComputerOperationStep = z.infer<typeof ComputerOperationStep>;

// How long each kind takes before a computer has done one. A restart counts as a start.
export const EXPECTED_OPERATION_MS = {
  "first-start": 60_000,
  start: 20_000,
  update: 40_000,
  stop: 5_000,
} as const satisfies Record<Exclude<ComputerOperationKind, "restart">, number>;
export type TimedOperationKind = keyof typeof EXPECTED_OPERATION_MS;

const Ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ComputerOperation = z.strictObject({
  kind: ComputerOperationKind,
  step: ComputerOperationStep,
  // The daemon's clock when it began, in ms. It names the operation.
  startedAt: Ms,
  // How long it had run when the daemon made this summary, so a page needs no daemon clock.
  elapsedMs: Ms,
  // How long the last one of its kind took on this computer, or the default before there was one.
  expectedMs: Ms.min(1),
});
export type ComputerOperation = z.infer<typeof ComputerOperation>;
