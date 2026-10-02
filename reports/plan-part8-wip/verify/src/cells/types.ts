// Scratch stand-in for Part 2's apps/daemon/src/cells/types.ts with Part 8's additions.
export type Scale = 1 | 2;
export type CellKind = "desktop" | "browser";
export interface CellDocker {
  internalNetwork: string;
  egressNetwork: string;
  homeVolume: string;
  gate: string;
  desktop: string;
  gateInternalIp: string;
  gateEgressIp: string;
  desktopIp: string;
  cellFilesVolume?: string;
}
export interface CellRecord {
  v: 1;
  id: string;
  createdAt: string;
  scale: Scale;
  keydPort: number;
  tokens: { desktopd: string; stream: string };
  docker: CellDocker;
  kind?: CellKind;
  parent?: string;
}
