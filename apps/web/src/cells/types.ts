import type { ComputerOperation } from "@localdot/protocol";

export type Scale = 1 | 2;

export type CellState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "removed";

export type StreamConnection = "none" | "connecting" | "live" | "stalled" | "disconnected";

export interface StreamState {
  connection: StreamConnection;
  viewers: number;
  lastUpstreamAt: number | null;
}

export interface CellSummary {
  fenced?: { revision: number };
  replacementPending?: true;
  id: string;
  state: CellState;
  scale: Scale;
  createdAt: string;
  stream: StreamState;
  error?: string;
  // Frozen by Stop until Resume refreshes credentials and thaws the desktop.
  paused?: true;
  // A newer build of the computer is ready; Update restarts it on that build.
  updateAvailable?: true;
  updating?: true;
  // Its update can't be finished; only a fresh start brings the computer back.
  needsFreshStart?: true;
  // The start, update or stop going on, from when the daemon began it.
  operation?: ComputerOperation;
}
