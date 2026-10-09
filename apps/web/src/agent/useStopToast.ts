import { useEffect, useRef } from "react";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import type { ToastOptions } from "../ui/toasts.ts";
import type { StopStatus } from "./useTaskControls.ts";

const TOAST = "task-stop";
const PAUSE_FAILED = "pause: could not confirm completion";

// The kill switch's cleanup notes (StopOutcome.errors), in plain words.
const NOTES: Record<string, string> = {
  "keyd: could not confirm completion": "Couldn't confirm that dot's use of your keys was cut off.",
  [PAUSE_FAILED]: "Your computer didn't pause, so it was shut down instead.",
  "keyd close: could not confirm completion": "Couldn't confirm that your keys were locked away.",
  "stop: could not confirm completion": "Couldn't confirm that your computer shut down.",
};

export function cleanupNote(error: string): string {
  return NOTES[error] ?? "Part of the cleanup couldn't be confirmed.";
}

// What a Stop's outcome says as it drops from the island. While it is on its way the island's own
// label says so; once it is in, the island carries the state and this the news. A computer left
// paused or off shows its own way back (the island's Resume, the curtain's Turn on), so only an
// unconfirmed Stop brings an action here.
export function stopNotice(
  status: StopStatus,
  curtain = false,
): Omit<ToastOptions, "action"> | null {
  const off = status.phase === "stopped";
  // A computer that is off because it couldn't pause says so in its title.
  const details = status.errors
    .filter((error) => !(off && error === PAUSE_FAILED))
    .map(cleanupNote);
  const notes = details.length ? { details } : {};
  // With the computer off, the curtain says it in dot's place; only notes still need the toast.
  if (off && curtain && !details.length) return null;
  switch (status.phase) {
    case "idle":
    case "sending":
      return null;
    case "paused":
      return { id: TOAST, icon: "stop", title: "Stopped. Your computer is paused.", ...notes };
    case "stopped":
      return {
        id: TOAST,
        icon: "stop",
        title: status.errors.includes(PAUSE_FAILED)
          ? "Stopped. Your computer couldn't pause, so it's off."
          : "Stopped. Your computer is off.",
        ...notes,
      };
    case "unconfirmed":
      return {
        id: TOAST,
        tone: "danger",
        title: "Couldn't confirm that dot stopped.",
        urgency: "assertive",
        ...notes,
      };
  }
}

// What the curtain says under "Your computer is off" after a Stop turned it off.
export function stoppedOff(status: StopStatus): string | null {
  if (status.phase !== "stopped") return null;
  return status.errors.includes(PAUSE_FAILED)
    ? "dot stopped. Your computer couldn't pause, so it's off. Your files are kept."
    : "dot stopped, and your computer is off. Your files are kept.";
}

export function useStopToast(status: StopStatus, recheck: () => void, curtain = false) {
  const latest = useRef(recheck);
  latest.current = recheck;
  const notice = stopNotice(status, curtain);
  const key = notice ? JSON.stringify(notice) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the notice is rebuilt each render; its words are what change
  useEffect(() => {
    if (!notice) {
      dismissToast(TOAST);
      return;
    }
    showToast({
      ...notice,
      ...(status.phase === "unconfirmed"
        ? { action: { label: "Check again", onAction: () => latest.current() } }
        : {}),
    });
  }, [key]);
  useEffect(() => () => dismissToast(TOAST), []);
}
