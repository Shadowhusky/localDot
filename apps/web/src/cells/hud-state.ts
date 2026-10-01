import type { CellSummary } from "./types.ts";

export interface HudState {
  label: string;
  caption: string;
  action: "start" | "stop" | "none";
  live: boolean;
}

// The orchestrator marks a crash restart with this note on a starting cell; the spec shows a
// crashed cell as "Reconnecting…".
const RESTART_NOTE = /; restarting \(attempt \d+ of \d+\)$/;

export function hudFor(cell: CellSummary | null, busy: boolean): HudState {
  const idle = (label: string, caption: string, action: HudState["action"]): HudState => ({
    label,
    caption,
    action: busy ? "none" : action,
    live: false,
  });
  if (!cell) return idle("No computer", "Start your computer to see it here.", "start");
  switch (cell.state) {
    case "starting":
      if (cell.error && RESTART_NOTE.test(cell.error))
        return idle("Reconnecting…", cell.error, "stop");
      return idle(
        "Starting…",
        cell.error ?? "Starting your computer. The first start takes about a minute.",
        "none",
      );
    case "stopping":
      return idle("Stopping…", "Stopping your computer.", "none");
    case "stopped":
    case "removed":
      return idle("Stopped", "Your computer is off.", "start");
    case "failed":
      return idle("Failed", cell.error ?? "Your computer could not start.", "start");
    case "ready":
      break;
  }
  switch (cell.stream.connection) {
    case "live":
      return {
        label: "Live",
        caption: "Your computer is live.",
        action: busy ? "none" : "stop",
        live: true,
      };
    case "stalled":
    case "disconnected":
      return idle("Reconnecting…", "The stream paused. Reconnecting.", "stop");
    default:
      return idle("Connecting…", "Connecting to the stream.", "stop");
  }
}
