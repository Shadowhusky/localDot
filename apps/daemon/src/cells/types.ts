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

export interface CellRecord {
  v: 1;
  id: string;
  createdAt: string;
  scale: Scale;
  keydPort: number;
  tokens: { desktopd: string; stream: string };
  docker: CellDocker;
}

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
