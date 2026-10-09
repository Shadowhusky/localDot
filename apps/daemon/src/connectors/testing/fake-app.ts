import type { ConnectorConfig } from "@localdot/protocol";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorLinks } from "../hub.ts";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  reply?(args: Record<string, unknown>): { text: string; isError?: boolean };
}

// An MCP server in memory, standing in for a user's app: it lists the given tools and records
// every call it gets.
export function fakeApp(tools: FakeTool[]) {
  const calls: { connector: string; name: string; args: Record<string, unknown> }[] = [];
  const state = { opened: 0, closed: 0, fail: undefined as Error | undefined };
  const links: ConnectorLinks = {
    async open(config: ConnectorConfig) {
      if (state.fail) throw state.fail;
      state.opened++;
      const [client, server] = InMemoryTransport.createLinkedPair();
      const app = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
      app.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      }));
      app.setRequestHandler(CallToolRequestSchema, (request) => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ connector: config.id, name: request.params.name, args });
        const tool = tools.find((t) => t.name === request.params.name);
        if (!tool) throw new McpError(-32602, `Unknown tool ${request.params.name}`);
        const out = tool.reply?.(args) ?? { text: `${tool.name} done` };
        return { content: [{ type: "text", text: out.text }], isError: out.isError === true };
      });
      await app.connect(server);
      return {
        transport: client,
        close: async () => {
          state.closed++;
          await app.close();
        },
      };
    },
  };
  return { links, calls, state };
}
