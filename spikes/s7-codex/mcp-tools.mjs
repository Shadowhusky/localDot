import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const png = readFileSync(join(here, "..", "s5-models", "out", "probe.png"));
const server = new McpServer({ name: "localdot-spike", version: "0.0.0" });

server.registerTool("screenshot", { description: "Screenshot of the 1280x800 screen." }, async () => ({
  content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
}));

server.registerTool(
  "click",
  {
    description: "Left-click at screen pixel coordinates on the 1280x800 screen.",
    inputSchema: { x: z.number(), y: z.number() },
  },
  async ({ x, y }) => {
    appendFileSync(join(here, "out", "clicks.jsonl"), `${JSON.stringify({ x, y, at: Date.now() })}\n`);
    return { content: [{ type: "text", text: `clicked (${x}, ${y})` }] };
  },
);

await server.connect(new StdioServerTransport());
