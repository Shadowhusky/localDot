import { MAIN_DOT_ID } from "../../../../packages/protocol/src/dots.ts";

export interface DotServiceNames {
  keyd: string;
  daemon: string;
}

// The first dot keeps the names the source installer and development setup have always used.
export function launchdLabels(id: string): DotServiceNames {
  if (id === MAIN_DOT_ID) return { keyd: "dev.localdot.keyd", daemon: "dev.localdot.daemon" };
  return { keyd: `dev.localdot.${id}.keyd`, daemon: `dev.localdot.${id}.daemon` };
}

export function systemdUnits(id: string): DotServiceNames {
  if (id === MAIN_DOT_ID)
    return { keyd: "localdot-keyd.service", daemon: "localdot-daemon.service" };
  return { keyd: `localdot-${id}-keyd.service`, daemon: `localdot-${id}-daemon.service` };
}
