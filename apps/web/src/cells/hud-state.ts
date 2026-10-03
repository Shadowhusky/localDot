import { DOCKER_DOWN } from "./errors.ts";
import type { CellSummary } from "./types.ts";

// What useCell knows: "listing" until the daemon first answers the list, "unknown" once a list has
// failed (the computer may or may not exist), "known" after a list answered.
export type CellStatus = "listing" | "unknown" | "known";

// The request useCell is waiting on, if any.
export type Pending = "list" | "create" | "start" | "stop" | "resume";

export interface CellView {
  cell: CellSummary | null;
  status: CellStatus;
  pending: Pending | null;
}

export type HudActionKind = "start" | "stop" | "retry" | "resume";

export interface HudState {
  label: string;
  caption: string;
  // The primary control remains focusable while pending. A paused computer also offers Stop.
  action: { kind: HudActionKind; enabled: boolean };
  live: boolean;
  // Independent of the currently offered action, including recovery/list requests.
  paused?: true;
}

// The orchestrator marks a crash restart with this note on a starting cell; the spec shows a
// crashed cell as "Reconnecting…".
const RESTART_NOTE = /; restarting \(attempt (\d+) of (\d+)\)$/;
const STARTING = "Starting your computer. The first start takes about a minute.";

export function hudFor({ cell, status, pending }: CellView): HudState {
  const idle = pending === null;
  const hud = (
    label: string,
    caption: string,
    kind: HudActionKind,
    enabled = true,
    live = false,
  ): HudState => ({
    label,
    caption,
    action: { kind, enabled: enabled && idle },
    live,
    ...(cell?.paused ? { paused: true as const } : {}),
  });

  if (status === "listing") return hud("Checking…", "Looking for your computer.", "start", false);
  if (status === "unknown") {
    return hud("Unavailable", "localDot can't tell whether your computer is running.", "retry");
  }
  if (pending === "list")
    return cell?.paused
      ? hud("Paused", "Checking your paused computer.", "resume", false)
      : hud("Checking…", "Looking for your computer.", cell ? "stop" : "start");
  if (!cell) {
    // The create's answer brings the cell id that Stop needs.
    if (pending === "create") return hud("Starting…", STARTING, "stop", false);
    return hud("No computer", "Start your computer to see it here.", "start");
  }
  switch (cell.state) {
    case "starting": {
      if (cell.paused)
        return hud(
          "Paused",
          "Your computer is frozen while its connection recovers. Stop it for a clean start.",
          "stop",
        );
      const restart = cell.error ? RESTART_NOTE.exec(cell.error) : null;
      if (restart) {
        return hud(
          "Reconnecting…",
          `Your computer stopped unexpectedly. Restarting it (attempt ${restart[1]} of ${restart[2]}).`,
          "stop",
        );
      }
      // Readiness runs outside the daemon's queue, so a Stop is accepted while starting.
      return hud("Starting…", STARTING, "stop");
    }
    case "stopping":
      return hud("Stopping…", "Stopping your computer.", "start", false);
    case "stopped":
    case "removed":
      return hud("Stopped", "Your computer is off.", "start");
    case "failed":
      // A stop that failed left the containers up: Stop is what finishes it.
      return hud(
        "Failed",
        describeCellError(cell.error),
        cell.error?.startsWith(STOP_FAILED) ? "stop" : "start",
      );
    case "ready":
      break;
  }
  if (cell.paused) {
    return hud(
      "Paused",
      "Stopped. Your computer is frozen. Resume it to use it again: programs dot started carry on. Stop it for a clean start.",
      "resume",
    );
  }
  switch (cell.stream.connection) {
    case "live":
      return hud("Live", "Your computer is live.", "stop", true, true);
    case "stalled":
    case "disconnected":
      return hud("Reconnecting…", "The stream paused. Reconnecting.", "stop");
    default:
      return hud("Connecting…", "Connecting to the stream.", "stop");
  }
}

const STOP_FAILED = "stop failed: ";
// A DockerError's message: "docker <status|unreachable> on <path>: <Docker's message>".
const DOCKER_ERROR = /^docker (unreachable|\d+) on /;

// The orchestrator's failure notes (apps/daemon/src/cells/orchestrator.ts) in plain words. They can
// carry Docker's own text, which stays out of the caption.
function describeCellError(error: string | undefined): string {
  if (!error) return "Your computer could not start.";
  if (error.startsWith(STOP_FAILED)) {
    return DOCKER_ERROR.test(error.slice(STOP_FAILED.length))
      ? `Your computer didn't stop: ${DOCKER_DOWN}, then stop it again.`
      : "Your computer didn't stop. Stop it again.";
  }
  if (/; gave up after \d+ restarts$/.test(error)) {
    return "Your computer kept stopping unexpectedly. Start it again when you're ready.";
  }
  if (error.startsWith("not ready after ")) {
    return "Your computer didn't finish starting. Start it again.";
  }
  if (error.endsWith("removed outside localDot")) {
    return "Your computer's containers were removed outside localDot.";
  }
  if (DOCKER_ERROR.test(error)) return `${DOCKER_DOWN}, then start your computer again.`;
  if (/container exited with \d+/.test(error)) {
    return "Your computer stopped unexpectedly. Start it again.";
  }
  if (error.startsWith("background check stopped")) {
    return "localDot lost track of your computer. Start it again.";
  }
  return "Your computer could not start.";
}
