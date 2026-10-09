import type { StreamPicture } from "../stage/live-stream.ts";
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
  // What this viewer's stage shows of the computer, which the daemon's stream state can lag or
  // miss: another viewer's relay keeps it live while this one reconnects.
  picture?: StreamPicture;
}

export type HudActionKind = "start" | "stop" | "retry" | "resume";

// Where the computer is in its life.
export type ComputerPhase =
  | "checking"
  | "none"
  | "starting"
  | "restarting"
  | "connecting"
  | "live"
  | "reconnecting"
  | "frozen"
  | "stopping"
  | "stopped"
  | "failed"
  | "unavailable";

export interface HudState {
  phase: ComputerPhase;
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
const UPDATING = "Updating your computer. Your files and sign-ins stay.";
const UPDATE_UNFINISHED = "The update didn't finish";
const UPDATE_RECORDS_UNREADABLE = "localDot can't read its update records";

export function hudFor({ cell, status, pending, picture = "none" }: CellView): HudState {
  const idle = pending === null;
  const hud = (
    phase: ComputerPhase,
    label: string,
    caption: string,
    kind: HudActionKind,
    enabled = true,
  ): HudState => ({
    phase,
    label,
    caption,
    action: { kind, enabled: enabled && idle },
    live: phase === "live",
    ...(cell?.paused ? { paused: true as const } : {}),
  });

  if (status === "listing")
    return hud("checking", "Checking…", "Looking for your computer.", "start", false);
  if (status === "unknown") {
    return hud(
      "unavailable",
      "Unavailable",
      "localDot can't tell whether your computer is running.",
      "retry",
    );
  }
  if (pending === "list")
    return cell?.paused
      ? hud("frozen", "Paused", "Checking your paused computer.", "resume", false)
      : hud("checking", "Checking…", "Looking for your computer.", cell ? "stop" : "start");
  if (!cell) {
    // The create's answer brings the cell id that Stop needs.
    if (pending === "create") return hud("starting", "Starting…", STARTING, "stop", false);
    return hud("none", "No computer", "Turn on your computer to see it here.", "start");
  }
  if (cell.fenced)
    return hud(
      "unavailable",
      "Unavailable",
      "Use Replace computer to recover on a verified fresh computer. Old files are retained.",
      "retry",
      false,
    );
  if (cell.replacementPending)
    return hud(
      "starting",
      "Verifying…",
      "The fresh computer is held until replacement verification completes.",
      "retry",
      false,
    );
  // The daemon stops the computer, moves it onto the new build and starts it: one step to the user.
  if (cell.updating && (cell.state === "stopping" || cell.state === "starting"))
    return hud("starting", "Updating…", UPDATING, "stop", false);
  switch (cell.state) {
    case "starting": {
      if (cell.paused)
        return hud(
          "frozen",
          "Paused",
          "Your computer is paused while its connection recovers. Shut it down for a fresh start.",
          "stop",
        );
      const restart = cell.error ? RESTART_NOTE.exec(cell.error) : null;
      if (restart) {
        return hud(
          "restarting",
          "Reconnecting…",
          `Your computer stopped unexpectedly. Restarting it (attempt ${restart[1]} of ${restart[2]}).`,
          "stop",
        );
      }
      // Readiness runs outside the daemon's queue, so a Stop is accepted while starting.
      return hud("starting", "Starting…", STARTING, "stop");
    }
    case "stopping":
      return hud("stopping", "Stopping…", "Stopping your computer.", "start", false);
    case "stopped":
    case "removed":
      return hud("stopped", "Stopped", "Your computer is off.", "start");
    case "failed":
      // A stop that failed left the containers up: Stop is what finishes it.
      return hud(
        "failed",
        "Failed",
        describeCellError(cell.error),
        cell.error?.startsWith(STOP_FAILED) ? "stop" : "start",
      );
    case "ready":
      break;
  }
  if (cell.paused) {
    return hud(
      "frozen",
      "Paused",
      "Your computer is paused. Resume it to carry on, or shut it down for a fresh start.",
      "resume",
    );
  }
  // A stage that has shown the computer keeps its picture through a reconnect.
  const connection = cell.stream.connection;
  if (connection === "stalled" || connection === "disconnected" || picture === "held")
    return hud("reconnecting", "Reconnecting…", "The stream paused. Reconnecting.", "stop");
  if (connection === "live" || picture === "live")
    return hud("live", "Ready", "Your computer is live.", "stop");
  return hud("connecting", "Connecting…", "Connecting to the stream.", "stop");
}

const STOP_FAILED = "stop failed: ";
// A DockerError's message: "docker <status|unreachable> on <path>: <Docker's message>".
const DOCKER_ERROR = /^docker (unreachable|\d+) on /;

// The orchestrator's failure notes (apps/daemon/src/cells/orchestrator.ts) in plain words. They can
// carry Docker's own text, which stays out of the caption.
function describeCellError(error: string | undefined): string {
  if (!error) return "Your computer could not start.";
  if (error.startsWith(UPDATE_UNFINISHED))
    return "The update didn't finish. Turn on your computer to finish it.";
  if (error.startsWith(UPDATE_RECORDS_UNREADABLE))
    return "localDot can't read its update records. Restart localDot, then turn on your computer.";
  if (error.startsWith(STOP_FAILED)) {
    return DOCKER_ERROR.test(error.slice(STOP_FAILED.length))
      ? `Your computer didn't stop: ${DOCKER_DOWN}, then stop it again.`
      : "Your computer didn't stop. Stop it again.";
  }
  if (/; gave up after \d+ restarts$/.test(error)) {
    return "Your computer kept stopping unexpectedly. Turn it on again when you're ready.";
  }
  if (error.startsWith("not ready after ")) {
    return "Your computer didn't finish starting. Turn it on again.";
  }
  if (error.endsWith("removed outside localDot")) {
    return "Your computer's containers were removed outside localDot.";
  }
  if (DOCKER_ERROR.test(error)) return `${DOCKER_DOWN}, then turn on your computer again.`;
  if (/container exited with \d+/.test(error)) {
    return "Your computer stopped unexpectedly. Turn it on again.";
  }
  if (error.startsWith("background check stopped")) {
    return "localDot lost track of your computer. Turn it on again.";
  }
  return "Your computer could not start.";
}
