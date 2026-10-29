import type { PortRange } from "../cells/ports.ts";

// LOCALDOT_PREVIEW_PORTS ("4900-4915"): the loopback ports this daemon may hold for previews, one
// per open preview. Each localDot on a machine gets a block of its own; a port something else holds
// is skipped when a preview opens.
export const PREVIEW_PORTS: PortRange = { from: 4900, to: 4915 };
const MAX_PORTS = 256;

export function previewPortRange(text: string | undefined): PortRange {
  if (text === undefined || text === "") return PREVIEW_PORTS;
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(text);
  const from = Number(m?.[1]);
  const to = Number(m?.[2]);
  if (!m || from < 1024 || to > 65535 || from > to || to - from >= MAX_PORTS)
    throw new RangeError(
      `not a preview port range: ${JSON.stringify(text)} (want e.g. 4900-4915, at most ${MAX_PORTS} ports)`,
    );
  return { from, to };
}
