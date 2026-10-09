import type { ComputerOperation, SelfTestReport } from "@localdot/protocol";

export type Scale = 1 | 2;

export type CellState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "removed";

export type StreamConnection = "none" | "connecting" | "live" | "stalled" | "disconnected";

export interface StreamState {
  connection: StreamConnection;
  viewers: number;
  lastUpstreamAt: number | null;
}

export const NO_STREAM: StreamState = { connection: "none", viewers: 0, lastUpstreamAt: null };

export interface CellSummary {
  fenced?: { revision: number };
  replacementPending?: true;
  // Stop freezes every desktop process until the user resumes or restarts it.
  paused?: true;
  // Its images have newer builds under the same tags; Update moves it onto them.
  updateAvailable?: true;
  updating?: true;
  // Its update can't be finished; a fresh start is the way back.
  needsFreshStart?: true;
  // The start, update or stop going on, from when the daemon began it.
  operation?: ComputerOperation;
  id: string;
  state: CellState;
  scale: Scale;
  createdAt: string;
  stream: StreamState;
  error?: string;
}

export interface CellDocker {
  internalNetwork: string;
  egressNetwork: string;
  homeVolume: string;
  gate: string;
  desktop: string;
  gateInternalIp: string;
  gateEgressIp: string;
  desktopIp: string;
}

export interface CellOwnership {
  desktop: string;
  gate: string;
  internalNetwork: string;
  egressNetwork: string;
}

export interface CellRecord {
  ownership?: CellOwnership;
  v: 2;
  kind: "desktop";
  id: string;
  createdAt: string;
  scale: Scale;
  keydPort: number;
  // capture: the gate's credential for the connections it captures; computers made before
  // capture existed have none and reach out only through the proxy.
  tokens: { desktopd: string; stream: string; capture?: string };
  docker: CellDocker;
}

export interface BrowserCellDocker {
  internalNetwork: string;
  egressNetwork: string;
  profileVolume: string;
  gate: string;
  browser: string;
  gateInternalIp: string;
  gateEgressIp: string;
  browserIp: string;
}

export interface BrowserCellOwnership {
  browser: string;
  gate: string;
  internalNetwork: string;
  egressNetwork: string;
}

export interface BrowserCellRecord {
  v: 2;
  kind: "browser";
  id: string;
  parentCellId: string;
  createdAt: string;
  scale: Scale;
  keydPort: number;
  tokens: { browserd: string; stream: string };
  docker: BrowserCellDocker;
  ownership?: BrowserCellOwnership;
}

export type StoredCellRecord = CellRecord | BrowserCellRecord;

export interface DesktopdEndpoint {
  baseUrl: string;
  token: string;
}

export interface StreamEndpoint {
  baseUrl: string;
  authorization: string;
}

export interface CellEndpoints {
  desktopd: DesktopdEndpoint;
  stream: StreamEndpoint;
}

// What desktopd's GET /healthz returns (cells/desktop/desktopd/src/app.ts).
export interface DesktopdHealth {
  selftest?: SelfTestReport;
  ok: boolean;
  scale: Scale;
  display: string;
  screen: { w: number; h: number } | null;
  hidpi: {
    ok: boolean;
    expected: { windowScalingFactor: Scale; xftDpi: 96 };
    windowScalingFactor: number | null;
    xftDpi: number | null;
  };
}
