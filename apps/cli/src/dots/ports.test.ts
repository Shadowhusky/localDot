import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DOT_PORTS, DotPorts } from "../../../../packages/protocol/src/dots.ts";
import { allocatePorts, blockPorts, MAX_BLOCKS, portIsFree, portsOf } from "./ports.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("a dot's ports", () => {
  it("mirror the first dot's block, 1000 higher each, clear of every other block", () => {
    expect(blockPorts(1)).toEqual({
      app: 5750,
      tool: 5751,
      keyd: [5760, 5789],
      preview: [5850, 5865],
    });
    const taken = new Set(portsOf(DEFAULT_DOT_PORTS));
    for (let block = 1; block <= MAX_BLOCKS; block++) {
      const ports = blockPorts(block);
      expect(DotPorts.safeParse(ports).success).toBe(true);
      for (const port of portsOf(ports)) {
        expect(taken.has(port)).toBe(false);
        taken.add(port);
      }
      expect(portsOf(ports)).not.toContain(5900);
    }
    expect(() => blockPorts(0)).toThrow();
    expect(() => blockPorts(MAX_BLOCKS + 1)).toThrow();
  });

  it("take the first block no dot uses and nothing here listens on", async () => {
    const busy = new Set([5760]);
    const ports = await allocatePorts([DEFAULT_DOT_PORTS], async (port) => !busy.has(port));
    expect(ports).toEqual(blockPorts(2));
    expect(await allocatePorts([DEFAULT_DOT_PORTS, blockPorts(2)], async () => true)).toEqual(
      blockPorts(1),
    );
    await expect(allocatePorts([], async () => false)).rejects.toThrow("No free set of ports");
  });

  it("see a port something listens on", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    expect(await portIsFree(address.port)).toBe(false);
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await portIsFree(address.port)).toBe(true);
  });
});
