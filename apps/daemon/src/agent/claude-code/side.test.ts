import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { ModelAnswerError } from "../safety/judge-model.ts";
import type { SideGo } from "../side/agent.ts";
import { SIDE_TOOL_NAMES } from "../side/tools.ts";
import { claudeCodeSideModel, onlySideTools, SIDE_SERVER, SIDE_TOOLS } from "./side.ts";

const launch = { executable: "/bin/claude", cwd: "/tmp", env: {} };
const finishTool = `mcp__${SIDE_SERVER}__finish`;

// A plan's Claude Code, as far as a side question can tell: `script` plays its messages, and may
// use the MCP server it was given as Claude Code itself would.
function fake(script: (options: Options, client: Client) => AsyncGenerator<unknown>) {
  const seen: { prompt: string; options: Options }[] = [];
  const closed = vi.fn();
  return {
    seen,
    closed,
    deps: {
      launch: async () => launch as never,
      spawn: vi.fn() as never,
      query: ({ prompt, options }: { prompt: string; options: Options }) => {
        seen.push({ prompt, options });
        const run = async function* () {
          const server = options.mcpServers?.[SIDE_SERVER] as {
            instance: { connect(t: unknown): Promise<void> };
          };
          const [ours, theirs] = InMemoryTransport.createLinkedPair();
          await server.instance.connect(theirs);
          const client = new Client({ name: "claude", version: "1" });
          await client.connect(ours);
          yield* script(options, client);
        };
        return Object.assign(run(), { close: closed });
      },
    },
  };
}
function go() {
  let finished: unknown;
  const used = vi.fn();
  const notes: string[] = [];
  const call = vi.fn(async (name: string, input: unknown) => {
    if (name === "finish") finished = input;
    return {
      ok: true,
      text: `read ${name}`,
      images: [{ data: "AAAA", mediaType: "image/png" as const }],
    };
  });
  return {
    used,
    notes,
    call,
    go: {
      system: "SYS",
      prompt: "PROMPT",
      signal: new AbortController().signal,
      leftUSD: 0.2,
      turns: 10,
      used,
      note: (text: string) => notes.push(text),
      tools: {
        offered: () =>
          SIDE_TOOL_NAMES.map((name) => ({
            name,
            description: name,
            schema: { type: "object", properties: {} },
          })),
        call,
        get finished() {
          return finished as never;
        },
      },
    } as unknown as SideGo,
  };
}
const assistant = (id: string, content: unknown[], input = 50, output = 5) => ({
  type: "assistant",
  message: { id, content, usage: { input_tokens: input, output_tokens: output } },
});

describe("a side question on Claude Code", () => {
  it("runs in a process of its own with the side tools only, and none of Claude Code's", async () => {
    const f = fake(async function* (options, client) {
      expect(options.tools).toEqual([]);
      expect(options.disallowedTools).toContain("Bash");
      expect(options.disallowedTools).toContain("WebFetch");
      expect(options.persistSession).toBe(false);
      expect(Object.keys(options.mcpServers ?? {})).toEqual([SIDE_SERVER]);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...SIDE_TOOL_NAMES].sort());
      yield { type: "system", subtype: "init", tools: SIDE_TOOLS };
      await client.callTool({ name: "finish", arguments: { status: "found", answer: "Yes." } });
      yield assistant("m1", [{ type: "tool_use", name: finishTool }]);
    });
    const asked = go();
    await claudeCodeSideModel(f.deps, { model: "haiku" }, "fast").run(asked.go);
    expect(f.seen[0]?.prompt).toBe("PROMPT");
    expect(f.seen[0]?.options.model).toBe("haiku");
    expect(f.seen[0]?.options.systemPrompt).toBe("SYS");
    expect(f.closed).toHaveBeenCalledOnce();
    expect(asked.call).toHaveBeenCalledWith(
      "finish",
      { status: "found", answer: "Yes." },
      expect.anything(),
    );
  });

  it("allows only its own tools from its own server, at every call", async () => {
    const options = { signal: new AbortController().signal, toolUseID: "t" };
    const side = { source: "sdk", name: SIDE_SERVER };
    await expect(
      onlySideTools(finishTool, {}, { ...options, mcpServer: side } as never),
    ).resolves.toMatchObject({ behavior: "allow" });
    for (const name of [
      "Bash",
      "Write",
      "mcp__localdot__computer",
      "mcp__localdot__shell",
      `mcp__${SIDE_SERVER}__shell`,
    ])
      await expect(
        onlySideTools(name, {}, { ...options, mcpServer: side } as never),
      ).resolves.toMatchObject({ behavior: "deny" });
    // The same name from anything but the daemon's own server is someone else's.
    await expect(
      onlySideTools(finishTool, {}, {
        ...options,
        mcpServer: { source: "stdio", name: SIDE_SERVER },
      } as never),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("gives Claude Code the model's own turns as its limit", async () => {
    const f = fake(async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "x" };
    });
    await claudeCodeSideModel(f.deps, { model: "haiku" }, "fast").run(go().go);
    expect(f.seen[0]?.options.maxTurns).toBe(10);
  });

  it("hands tool results back with their pictures", async () => {
    let result: unknown;
    const f = fake(async function* (_options, client) {
      result = await client.callTool({ name: "look_at_screen", arguments: {} });
      await client.callTool({ name: "finish", arguments: { status: "found", answer: "Yes." } });
      yield assistant("m1", [{ type: "text", text: "Looking" }]);
    });
    const asked = go();
    await claudeCodeSideModel(f.deps, { model: "haiku" }, "fast").run(asked.go);
    expect(result).toMatchObject({
      content: [
        { type: "text", text: "read look_at_screen" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
    });
    expect(asked.notes).toContain("Looking");
  });

  it("counts tokens per reply, once for a reply told in several messages", async () => {
    const f = fake(async function* () {
      yield assistant("m1", [{ type: "text", text: "a" }]);
      yield assistant("m1", [{ type: "tool_use", name: `${finishTool}x` }].slice(0, 0));
      yield assistant("m2", [{ type: "text", text: "b" }], 70, 7);
      yield { type: "result", subtype: "success", is_error: false, result: "b" };
    });
    const asked = go();
    await claudeCodeSideModel(f.deps, { model: "haiku" }, "fast").run(asked.go);
    expect(asked.used.mock.calls.map((c) => c[0])).toEqual([
      { inputTokens: 50, outputTokens: 5 },
      { inputTokens: 70, outputTokens: 7 },
    ]);
  });

  it("gives up on a process that tries a tool of its own", async () => {
    const f = fake(async function* () {
      yield assistant("m1", [{ type: "tool_use", name: "Bash" }]);
    });
    await expect(
      claudeCodeSideModel(f.deps, { model: "haiku" }, "fast").run(go().go),
    ).rejects.toBeInstanceOf(ModelAnswerError);
    expect(f.closed).toHaveBeenCalledOnce();
  });

  it("passes on the plan's own words when it refuses", async () => {
    const f = fake(async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your usage limit · resets 3pm",
      };
    });
    await expect(
      claudeCodeSideModel(f.deps, { model: "haiku" }, "fast").run(go().go),
    ).rejects.toMatchObject({ reason: "You've hit your usage limit · resets 3pm" });
  });

  it("ends without a result at its limit of turns, for the agent to go on from", async () => {
    const f = fake(async function* () {
      yield { type: "result", subtype: "error_max_turns", is_error: true };
    });
    await expect(
      claudeCodeSideModel(f.deps, { model: "haiku" }, "fast").run(go().go),
    ).resolves.toBeUndefined();
  });

  it("says it is on a plan: it can use tools and images, and counts no money", () => {
    expect(
      claudeCodeSideModel(fake(async function* () {}).deps, { model: "opus" }, "main"),
    ).toMatchObject({
      provider: "claude-code",
      model: "opus",
      role: "main",
      tools: true,
      images: true,
      plan: true,
    });
  });
});
