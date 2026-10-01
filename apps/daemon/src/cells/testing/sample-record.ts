import { ulid } from "@localdot/protocol";
import type { CellRecord } from "../types.ts";

export function sampleRecord(id = ulid(), createdAt = "2026-10-01T10:00:00.000Z"): CellRecord {
  return {
    v: 1,
    id,
    createdAt,
    scale: 2,
    keydPort: 4760,
    tokens: { desktopd: "d".repeat(43), stream: "s".repeat(43) },
    docker: {
      internalNetwork: `localdot-cell-${id}`,
      egressNetwork: `localdot-egress-${id}`,
      homeVolume: `localdot-home-${id}`,
      gate: `localdot-gate-${id}`,
      desktop: `localdot-desktop-${id}`,
      gateInternalIp: "172.24.0.10",
      gateEgressIp: "172.25.0.10",
      desktopIp: "172.24.0.11",
    },
  };
}
