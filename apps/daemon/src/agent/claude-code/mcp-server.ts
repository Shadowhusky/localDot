import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CODEX_TOOL_DESCRIPTIONS,
  COMPUTER_DESCRIPTION,
  codexTools,
  type McpCallResult,
  type McpToolDescriptor,
} from "../codex/mcp-tools.ts";
import { LOCALDOT_SERVER } from "./options.ts";

export type LocaldotCall = (
  name: string,
  input: unknown,
  signal: AbortSignal,
) => Promise<McpCallResult>;

// The same table and schemas the ChatGPT plan's Codex sees. Here an action is checked against the
// newest full screenshot dot had seen when it chose the action.
export function localdotTools(research = false): McpToolDescriptor[] {
  return codexTools(
    {
      ...CODEX_TOOL_DESCRIPTIONS,
      computer: `${COMPUTER_DESCRIPTION} If the screen changed since the screenshot you acted on, the action is not done and the fresh screenshot comes back instead.`,
    },
    research,
  );
}

// localDot's tools, served inside the daemon: each call is answered by the daemon's own checks.
export function localdotServer(
  call: LocaldotCall,
  research = false,
  more: () => McpToolDescriptor[] = () => [],
): McpSdkServerConfigWithInstance {
  const instance = new McpServer(
    { name: LOCALDOT_SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...localdotTools(research), ...more()],
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    call(request.params.name, request.params.arguments ?? {}, extra.signal),
  );
  return { type: "sdk", name: LOCALDOT_SERVER, instance };
}
