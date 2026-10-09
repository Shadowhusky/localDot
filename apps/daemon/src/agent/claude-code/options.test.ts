import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { TOOL_NAMES } from "@localdot/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { codexTools } from "../codex/mcp-tools.ts";
import { localdotServer } from "./mcp-server.ts";
import { BUILT_IN_TOOLS, claudeCodeOptions, LOCALDOT_TOOLS, onlyLocaldot } from "./options.ts";

const launch = {
  executable: "/Users/person/.local/bin/claude",
  env: { HOME: "/Users/person", PATH: "/usr/bin" },
  cwd: "/private/localdot/claude-code/work",
};
function options() {
  const call = vi.fn(async () => ({
    isError: false,
    content: [{ type: "text" as const, text: "ok" }],
  }));
  const server = localdotServer(call);
  return {
    call,
    server,
    options: claudeCodeOptions({
      launch,
      model: "sonnet",
      instructions: "You are dot.",
      server,
      abort: new AbortController(),
      spawn: () => ({}) as SpawnedProcess,
    }),
  };
}
async function connect(server: ReturnType<typeof localdotServer>) {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(transport);
  const mcp = new Client({ name: "fixture", version: "1.0.0" });
  await mcp.connect(client);
  return mcp;
}

describe("Claude Code as dot's brain", () => {
  it("offers exactly localDot's tools over MCP, with every built-in tool off", () => {
    const { options: o, server } = options();
    expect(o.tools).toEqual([]);
    // Nothing is approved ahead: each call goes through the gate, which knows only localDot's.
    expect(o.allowedTools).toBeUndefined();
    expect(o.canUseTool).toBe(onlyLocaldot);
    expect(LOCALDOT_TOOLS).toEqual(TOOL_NAMES.map((name) => `mcp__localdot__${name}`));
    expect(o.mcpServers).toEqual({ localdot: server });
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe("default");
    for (const tool of ["Bash", "Read", "Edit", "Write", "WebFetch", "WebSearch", "Task", "Agent"])
      expect(o.disallowedTools).toContain(tool);
    expect(o.disallowedTools).toEqual(BUILT_IN_TOOLS);
  });
  it("loads none of the user's settings, memory, skills, plugins or agents, and keeps no history", () => {
    const { options: o } = options();
    expect(o.settingSources).toEqual([]);
    expect(o.systemPrompt).toBe("You are dot.");
    expect(o.skills).toEqual([]);
    expect(o.plugins).toEqual([]);
    expect(o.agents).toEqual({});
    expect(o.persistSession).toBe(false);
    expect(o.enableFileCheckpointing).toBe(false);
    expect(o.verbatimPrompts).toBe(true);
    expect(o.extraArgs).toEqual({ "disable-slash-commands": null, "no-chrome": null });
  });
  it("runs the user's own Claude Code in localDot's empty folder, with the environment it was given", () => {
    const { options: o } = options();
    expect(o.pathToClaudeCodeExecutable).toBe(launch.executable);
    expect(o.cwd).toBe(launch.cwd);
    expect(o.env).toEqual(launch.env);
    expect(o.model).toBe("sonnet");
    expect(o.resume).toBeUndefined();
    expect(o.continue).toBeUndefined();
  });
  it("allows only localDot's own in-process server when anything asks", async () => {
    const ask = (name: string, mcpServer?: { name: string; source: string }) =>
      onlyLocaldot(name, { a: 1 }, {
        signal: new AbortController().signal,
        ...(mcpServer ? { mcpServer } : {}),
      } as never);
    expect(await ask("mcp__localdot__computer", { name: "localdot", source: "sdk" })).toEqual({
      behavior: "allow",
      updatedInput: { a: 1 },
    });
    expect((await ask("Bash"))?.behavior).toBe("deny");
    expect(
      (await ask("mcp__localdot__computer", { name: "localdot", source: "user" }))?.behavior,
    ).toBe("deny");
    expect((await ask("mcp__other__thing", { name: "other", source: "sdk" }))?.behavior).toBe(
      "deny",
    );
  });
  it("serves the same tool table and schemas as the ChatGPT plan, and forwards calls", async () => {
    const { server, call } = options();
    const mcp = await connect(server);
    const listed = await mcp.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(LOCALDOT_TOOLS).toHaveLength(TOOL_NAMES.length);
    const codex = codexTools();
    for (const tool of listed.tools)
      expect(tool.inputSchema).toEqual(codex.find((row) => row.name === tool.name)?.inputSchema);
    const computer = listed.tools.find((tool) => tool.name === "computer")?.description ?? "";
    expect(computer).toContain("the fresh screenshot comes back instead");
    expect(computer).not.toContain("cancels this turn");
    const reply = await mcp.callTool({ name: "shell", arguments: { command: "ls" } });
    expect(reply).toEqual({ isError: false, content: [{ type: "text", text: "ok" }] });
    expect(call).toHaveBeenCalledWith("shell", { command: "ls" }, expect.any(AbortSignal));
    await mcp.close();
  });
});
