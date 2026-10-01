export const KEYD_PORT_RANGE = { from: 4760, to: 4789 } as const;

// Each cell gets its own keyd listener port; the gate relays to it and keyd knows the cell by it.
export function allocateKeydPort(inUse: Iterable<number>): number {
  const used = new Set(inUse);
  for (let port = KEYD_PORT_RANGE.from; port <= KEYD_PORT_RANGE.to; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`no free keyd listener port in ${KEYD_PORT_RANGE.from}-${KEYD_PORT_RANGE.to}`);
}
