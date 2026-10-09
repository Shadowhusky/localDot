import type { ConnectorConfig } from "@localdot/protocol";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConnectorCells } from "./cell.ts";
import type { ConnectorLinks, OpenLink } from "./hub.ts";
import { ConnectorProblem } from "./problem.ts";
import type { RemoteLinks } from "./remote.ts";

// A remote connector over HTTP through its keyd listener; a local one in its own connector cell.
export class CellAndRemoteLinks implements ConnectorLinks {
  constructor(private readonly deps: { remote?: RemoteLinks; cells?: ConnectorCells }) {}
  async open(config: ConnectorConfig, signal: AbortSignal): Promise<OpenLink> {
    const { server } = config;
    if (server.kind === "remote") {
      if (!this.deps.remote)
        throw new ConnectorProblem("failed", "Key protection is off, so apps can't be reached.");
      const link = await this.deps.remote.open(config.id, server);
      const url = new URL(server.url);
      const transport =
        server.transport === "sse"
          ? new SSEClientTransport(url, { fetch: link.fetch })
          : new StreamableHTTPClientTransport(url, { fetch: link.fetch });
      return { transport, close: link.close };
    }
    if (!this.deps.cells)
      throw new ConnectorProblem("failed", "Apps that run on your computer need Docker running.");
    const cell = await this.deps.cells.open(config.id, server, signal);
    return { transport: cell.transport, close: cell.close, stderr: () => cell.transport.stderr };
  }
}
