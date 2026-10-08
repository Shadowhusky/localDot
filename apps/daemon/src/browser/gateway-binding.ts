import type { StreamState } from "../cells/types.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import type { NativeScreenBinding } from "../gateway/gateway.ts";
import { browserGatewayDevice } from "./gateway-device.ts";
import type { ScreenController, ScreenLease, ScreenSelection } from "./screen-controller.ts";

export interface ScreenGatewayDeps {
  parentCellId: string;
  screens: ScreenController;
  registry: Pick<DesktopdRegistry, "for">;
  now(): number;
  // The caller must supply the selected physical screen's viewer state, including zero viewers.
  stream(selection: ScreenSelection): StreamState;
  subscribe(selection: ScreenSelection, listener: () => void): () => void;
}

export function screenGatewayBinding(
  deps: ScreenGatewayDeps,
  lease: ScreenLease,
): NativeScreenBinding {
  lease.check();
  const selection = lease.selection;
  if (selection.screen === "desktop" && selection.cellId !== deps.parentCellId)
    throw new Error("The desktop does not belong to this session.");
  const device =
    selection.screen === "browser"
      ? browserGatewayDevice({ ...deps.screens.browserAccess(lease), lease, now: deps.now })
      : deps.registry.for(deps.parentCellId);
  if (!device) throw new Error("The selected screen is unavailable.");
  lease.check();
  return Object.freeze({
    cellId: selection.cellId,
    parentCellId: deps.parentCellId,
    scale: selection.geometry.scale,
    device,
    signal: lease.signal,
    check: () => lease.check(),
    stream: () => {
      lease.check();
      return deps.stream(selection);
    },
    subscribe: (listener: () => void) => {
      lease.check();
      return deps.subscribe(selection, listener);
    },
  });
}
