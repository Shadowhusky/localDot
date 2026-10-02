export const KEYD_PORT_RANGE = { from: 4760, to: 4789 } as const;

export interface PortRange {
  from: number;
  to: number;
}

// Each cell gets its own keyd listener port; the gate relays to it and keyd knows the cell by it.
export function allocateKeydPort(
  inUse: Iterable<number>,
  range: PortRange = KEYD_PORT_RANGE,
): number {
  const used = new Set(inUse);
  for (let port = range.from; port <= range.to; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`no free keyd listener port in ${range.from}-${range.to}`);
}

// LOCALDOT_KEYD_PORTS ("4791-4797"): test harnesses run their own keyd outside the real range, and
// keyd's -ports must say the same.
export function parsePortRange(text: string | undefined): PortRange {
  if (text === undefined || text === "") return KEYD_PORT_RANGE;
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(text);
  const from = Number(m?.[1]);
  const to = Number(m?.[2]);
  if (!m || from < 1024 || to > 65535 || from > to) {
    throw new RangeError(`not a port range: ${JSON.stringify(text)} (want e.g. 4760-4789)`);
  }
  return { from, to };
}
