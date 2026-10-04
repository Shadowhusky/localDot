import { writeFileSync } from "node:fs";
import type { CellApi } from "../../apps/daemon/src/cells/orchestrator.ts";

// Invoke inside the owned daemon spike after Ready. No fixture invents a gate port or credential.
export function writeRecorderEndpoint(cells: CellApi, id: string, output: string): void {
  const endpoint = cells.endpoints(id)?.stream;
  if (!endpoint) throw new Error("Ready stream endpoint is unavailable");
  writeFileSync(output, `${JSON.stringify(endpoint)}\n`, { flag: "wx", mode: 0o600 });
}
