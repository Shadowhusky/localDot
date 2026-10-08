import { ulid } from "@localdot/protocol";
import { browserNames } from "../browser-spec.ts";
import type { BrowserCellRecord, CellRecord } from "../types.ts";
import { sampleRecord } from "./sample-record.ts";

export function sampleBrowserRecord(
  parent: CellRecord = sampleRecord(),
  id = ulid(),
): BrowserCellRecord {
  return {
    v: 2,
    kind: "browser",
    id,
    parentCellId: parent.id,
    createdAt: parent.createdAt,
    scale: parent.scale,
    keydPort: 4761,
    tokens: { browserd: "b".repeat(43), stream: "s".repeat(43) },
    docker: {
      ...browserNames(id),
      gateInternalIp: "172.26.0.10",
      gateEgressIp: "172.27.0.10",
      browserIp: "172.26.0.11",
    },
  };
}
