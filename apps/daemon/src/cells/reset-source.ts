import { ComputerResetSource } from "../../../../packages/protocol/src/computer-reset.ts";
import type { BrowserLedger } from "./browser-ledger.ts";
import { browserNames } from "./browser-spec.ts";
import type { CellRecord } from "./types.ts";

/** Capture only immutable public ownership facts. Missing resource IDs are not an invitation to
 * adopt by name: the retirement adapter must prove those names absent before deleting anything. */
export function captureComputerResetSource(
  cell: CellRecord,
  browser?: BrowserLedger,
): ComputerResetSource {
  if (browser && (browser.parentCellId !== cell.id || browser.id === cell.id))
    throw new Error("Reset browser ownership does not match the selected computer");
  const resource = (name: string, id: string | undefined, owner: string) => {
    if (!name.endsWith(`-${owner}`))
      throw new Error("Reset resource name does not match its owner");
    return { name, id: id ?? null };
  };
  const volume = (name: string, owner: string) => resource(name, undefined, owner).name;
  const names = browser ? browserNames(browser.id, browser.prefix) : undefined;
  return ComputerResetSource.parse({
    scale: cell.scale,
    desktop: {
      workload: resource(cell.docker.desktop, cell.ownership?.desktop, cell.id),
      gate: resource(cell.docker.gate, cell.ownership?.gate, cell.id),
      internalNetwork: resource(
        cell.docker.internalNetwork,
        cell.ownership?.internalNetwork,
        cell.id,
      ),
      egressNetwork: resource(cell.docker.egressNetwork, cell.ownership?.egressNetwork, cell.id),
      volume: volume(cell.docker.homeVolume, cell.id),
    },
    browser:
      browser && names
        ? {
            id: browser.id,
            owner: browser.owner,
            resources: {
              workload: resource(names.browser, browser.resources.browser, browser.id),
              gate: resource(names.gate, browser.resources.gate, browser.id),
              internalNetwork: resource(
                names.internalNetwork,
                browser.resources.internalNetwork,
                browser.id,
              ),
              egressNetwork: resource(
                names.egressNetwork,
                browser.resources.egressNetwork,
                browser.id,
              ),
              volume: volume(names.profileVolume, browser.id),
            },
          }
        : null,
  });
}
