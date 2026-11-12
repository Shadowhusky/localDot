import { t } from "../i18n/index.ts";
import type { AwayCause, AwayLevel } from "../stage/connection.ts";
import type { StreamPicture } from "../stage/live-stream.ts";
import { MEMORY_ADVICE } from "./errors.ts";
import type { CellSummary } from "./types.ts";

// What useCell knows: "listing" until the daemon first answers the list, "unknown" once a list has
// failed (the computer may or may not exist), "known" after a list answered.
export type CellStatus = "listing" | "unknown" | "known";

// The request useCell is waiting on, if any.
export type Pending = "list" | "create" | "start" | "stop" | "resume";

export interface CellView {
  runtimeProblem?: "docker" | "recovering" | "failed" | null;
  cell: CellSummary | null;
  status: CellStatus;
  pending: Pending | null;
  // What this viewer's stage shows of the computer, which the daemon's stream state can lag or
  // miss: another viewer's relay keeps it live while this one reconnects.
  picture?: StreamPicture;
  // This page has had a picture from the computer since it last came up: a stream that drops or
  // reconnects after that is a reconnect under the last picture, never the computer starting.
  streamed?: boolean;
  // The displayed stage requires its own painted frame, not another viewer's relay health.
  viewer?: boolean;
  // The picture this view has shown is away (stage/connection.ts).
  away?: { cause: AwayCause; level: AwayLevel } | null;
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
  // Only this viewer's screen is suspended, not the computer or task.
  | "suspended"
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
const STARTING = t`Starting your computer. The first start takes about a minute.`;
const UPDATING = t`Updating your computer. Your files and sign-ins stay.`;
const UPDATE_UNFINISHED = "The update didn't finish";
const UPDATE_RECORDS_UNREADABLE = "localDot can't read its update records";
export const NEEDS_FRESH_START = t`The update couldn't be finished. Start fresh to use your computer again.`;

export function hudFor({
  runtimeProblem,
  cell,
  status,
  pending,
  picture = "none",
  streamed = false,
  viewer = false,
  away = null,
}: CellView): HudState {
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

  if (runtimeProblem)
    return hud(
      "unavailable",
      t`Unavailable`,
      runtimeProblem === "docker"
        ? t`Docker is not available. Open Docker on this Mac; localDot will reconnect when it is ready.`
        : runtimeProblem === "recovering"
          ? t`Docker is ready. Recovering your computer connection.`
          : t`Startup recovery needs attention. Restart localDot to retry; your files are retained.`,
      "retry",
    );
  // A screen this page has shown keeps its last picture through any gap, whatever the screen's own
  // status meanwhile: a blip changes nothing and the stage tells of a switch, while a longer gap
  // reads as reconnecting, never as the computer coming up.
  if (away)
    return away.level === "blip" || away.cause === "switch"
      ? hud("live", t`Ready`, t`Your computer is live.`, "stop")
      : hud(
          "reconnecting",
          t`Reconnecting…`,
          away.cause === "browser"
            ? t`The web browser is starting again.`
            : t`The stream paused. Reconnecting.`,
          "stop",
        );
  if (status === "listing")
    return hud("checking", t`Checking…`, t`Looking for your computer.`, "start", false);
  if (status === "unknown") {
    if (
      viewer &&
      cell?.state === "ready" &&
      !cell.fenced &&
      !cell.replacementPending &&
      (picture === "live" || picture === "held" || picture === "suspended")
    )
      return hud("reconnecting", t`Reconnecting…`, t`Checking the computer connection.`, "retry");
    return hud(
      "unavailable",
      t`Unavailable`,
      t`localDot can't tell whether your computer is running.`,
      "retry",
    );
  }
  // A list check on a known computer keeps showing it, its controls held until the answer.
  if (pending === "list" && !cell)
    return hud("checking", t`Checking…`, t`Looking for your computer.`, "start");
  if (pending === "list" && cell?.paused)
    return hud("frozen", t`Paused`, t`Checking your paused computer.`, "resume", false);
  if (!cell) {
    // The create's answer brings the cell id that Stop needs.
    if (pending === "create") return hud("starting", t`Starting…`, STARTING, "stop", false);
    return hud("none", t`No computer`, t`Turn on your computer to see it here.`, "start");
  }
  if (cell.fenced)
    return hud(
      "unavailable",
      t`Unavailable`,
      t`Your computer needs a fresh start. Your apps, settings and files are kept.`,
      "retry",
      false,
    );
  if (cell.replacementPending)
    return hud(
      "starting",
      t`Verifying…`,
      t`The fresh computer is held until replacement verification completes.`,
      "retry",
      false,
    );
  // The daemon stops the computer, moves it onto the new build and starts it: one step to the user.
  if (cell.updating && (cell.state === "stopping" || cell.state === "starting"))
    return hud("starting", t`Updating…`, UPDATING, "stop", false);
  // Start still retries the update, but the curtain offers Start fresh as the way back.
  if (cell.needsFreshStart) return hud("failed", t`Failed`, NEEDS_FRESH_START, "start");
  switch (cell.state) {
    case "starting": {
      if (cell.paused)
        return hud(
          "frozen",
          t`Paused`,
          t`Your computer is paused while its connection recovers. Shut it down for a fresh start.`,
          "stop",
        );
      const restart = cell.error ? RESTART_NOTE.exec(cell.error) : null;
      if (restart) {
        const memory = outOfMemory(cell.error);
        return hud(
          "restarting",
          t`Reconnecting…`,
          memory
            ? memory.advice
              ? t`Your computer ran out of memory. Restarting it (attempt ${restart[1] ?? ""} of ${restart[2] ?? ""}). ${memory.advice}`
              : t`Your computer ran out of memory. Restarting it (attempt ${restart[1] ?? ""} of ${restart[2] ?? ""}).`
            : t`Your computer stopped unexpectedly. Restarting it (attempt ${restart[1] ?? ""} of ${restart[2] ?? ""}).`,
          "stop",
        );
      }
      // Readiness runs outside the daemon's queue, so a Stop is accepted while starting.
      return hud("starting", t`Starting…`, STARTING, "stop");
    }
    case "stopping":
      return hud("stopping", t`Stopping…`, t`Stopping your computer.`, "start", false);
    case "stopped":
    case "removed":
      return hud("stopped", t`Stopped`, t`Your computer is off.`, "start");
    case "failed":
      // A stop that failed left the containers up: Stop is what finishes it.
      return hud(
        "failed",
        t`Failed`,
        describeCellError(cell.error),
        cell.error?.startsWith(STOP_FAILED) ? "stop" : "start",
      );
    case "ready":
      break;
  }
  if (cell.paused) {
    return hud(
      "frozen",
      t`Paused`,
      t`Your computer is paused. Resume it to carry on, or shut it down for a fresh start.`,
      "resume",
    );
  }
  if (picture === "suspended")
    return hud(
      "suspended",
      t`Ready`,
      t`Your computer is running. The screen resumes when you return.`,
      "stop",
    );
  if (viewer && picture === "none")
    return hud("connecting", t`Connecting…`, t`Waiting for this screen's first picture.`, "stop");
  // A stage that has shown the computer keeps its picture through a reconnect.
  const connection = cell.stream.connection;
  if (connection === "stalled" || connection === "disconnected" || picture === "held")
    return hud("reconnecting", t`Reconnecting…`, t`The stream paused. Reconnecting.`, "stop");
  if (connection === "live" || picture === "live")
    return hud("live", t`Ready`, t`Your computer is live.`, "stop");
  return streamed
    ? hud("reconnecting", t`Reconnecting…`, t`The stream paused. Reconnecting.`, "stop")
    : hud("connecting", t`Connecting…`, t`Connecting to the stream.`, "stop");
}

const SCREEN_PHASES = new Set<ComputerPhase>(["live", "connecting", "reconnecting", "suspended"]);

// A separate browser owns the picture's health, while lifecycle actions still target its
// desktop. Only the desktop's stream states yield to that screen: failures, containment,
// pause and lifecycle operations always remain authoritative. The browser's own stop and start
// (it starts again in place) are only its picture on the way, never the computer's lifecycle.
export function withScreenHud(parent: HudState, screen?: HudState): HudState {
  if (
    !screen ||
    (parent.phase !== "live" &&
      !(parent.phase === "unavailable" && screen.phase === "reconnecting") &&
      parent.phase !== "connecting" &&
      parent.phase !== "reconnecting" &&
      parent.phase !== "suspended")
  )
    return parent;
  if (SCREEN_PHASES.has(screen.phase)) return { ...screen, action: parent.action };
  return {
    phase: "connecting",
    label: t`Connecting…`,
    caption: t`Waiting for this screen's first picture.`,
    action: parent.action,
    live: false,
  };
}

// Docker stopped the computer for memory; with several running, the daemon says what to raise.
const OUT_OF_MEMORY = /^(desktop|gate) container ran out of memory\b/;

function outOfMemory(error: string | undefined): { advice?: string } | undefined {
  if (!error || !OUT_OF_MEMORY.test(error)) return undefined;
  const advice = MEMORY_ADVICE.exec(error)?.[0];
  return advice ? { advice } : {};
}

const STOP_FAILED = "stop failed: ";
// A DockerError's message: "docker <status|unreachable> on <path>: <Docker's message>".
const DOCKER_ERROR = /^docker (unreachable|\d+) on /;

// The orchestrator's failure notes (apps/daemon/src/cells/orchestrator.ts) in plain words. They can
// carry Docker's own text, which stays out of the caption.
function describeCellError(error: string | undefined): string {
  if (!error) return t`Your computer could not start.`;
  const memory = outOfMemory(error);
  if (memory)
    return memory.advice
      ? t`Your computer ran out of memory. ${memory.advice}`
      : t`Your computer ran out of memory. Turn it on again.`;
  if (error.startsWith(UPDATE_UNFINISHED))
    return t`The update didn't finish. Turn on your computer to finish it.`;
  if (error.startsWith(UPDATE_RECORDS_UNREADABLE))
    return t`localDot can't read its update records. Restart localDot, then turn on your computer.`;
  if (error.startsWith(STOP_FAILED)) {
    return DOCKER_ERROR.test(error.slice(STOP_FAILED.length))
      ? t`Your computer didn't stop: Docker isn't answering. Check that Docker Desktop is running, then stop it again.`
      : t`Your computer didn't stop. Stop it again.`;
  }
  if (/; gave up after \d+ restarts$/.test(error)) {
    return t`Your computer kept stopping unexpectedly. Turn it on again when you're ready.`;
  }
  if (error.startsWith("not ready after ")) {
    return t`Your computer didn't finish starting. Turn it on again.`;
  }
  if (error.endsWith("removed outside localDot")) {
    return t`Your computer's containers were removed outside localDot.`;
  }
  if (DOCKER_ERROR.test(error))
    return t`Docker isn't answering. Check that Docker Desktop is running, then turn on your computer again.`;
  if (/container exited with \d+/.test(error)) {
    return t`Your computer stopped unexpectedly. Turn it on again.`;
  }
  if (error.startsWith("background check stopped")) {
    return t`localDot lost track of your computer. Turn it on again.`;
  }
  return t`Your computer could not start.`;
}
