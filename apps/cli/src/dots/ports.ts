import { createServer } from "node:net";
import {
  DEFAULT_DOT_PORTS,
  type DotPortRange,
  type DotPorts,
} from "../../../../packages/protocol/src/dots.ts";

export const MAX_BLOCKS = 20;

// Dot n's ports mirror the first dot's 4750 block, 1000 higher per dot: 5750 is the second dot's
// app, 5751 its tool API, 5760-5789 its key service and 5850-5865 its previews. Previews stay off
// 5900, which Screen Sharing uses.
export function blockPorts(block: number): DotPorts {
  if (!Number.isInteger(block) || block < 1 || block > MAX_BLOCKS)
    throw new RangeError("no such port block");
  const base = DEFAULT_DOT_PORTS.app + 1000 * block;
  return {
    app: base,
    tool: base + 1,
    keyd: [base + 10, base + 39],
    preview: [base + 100, base + 115],
  };
}

export function portsOf(ports: DotPorts): number[] {
  const span = ([first, last]: DotPortRange) =>
    Array.from({ length: last - first + 1 }, (_, i) => first + i);
  return [ports.app, ports.tool, ...span(ports.keyd), ...span(ports.preview)];
}

const overlaps = (a: DotPorts, b: DotPorts) => {
  const taken = new Set(portsOf(b));
  return portsOf(a).some((port) => taken.has(port));
};

export type PortProbe = (port: number) => Promise<boolean>;

// The first block that no registered dot uses and whose every port is free on this computer now.
export async function allocatePorts(
  used: readonly DotPorts[],
  free: PortProbe = portIsFree,
): Promise<DotPorts> {
  for (let block = 1; block <= MAX_BLOCKS; block++) {
    const ports = blockPorts(block);
    if (used.some((other) => overlaps(ports, other))) continue;
    let available = true;
    for (const port of portsOf(ports)) {
      if (!(await free(port))) {
        available = false;
        break;
      }
    }
    if (available) return ports;
  }
  throw new Error("No free set of ports is left for another dot on this computer.");
}

export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}
