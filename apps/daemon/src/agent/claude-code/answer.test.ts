import type { Options, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { claudeCodeAnswer } from "./answer.ts";
import { BUILT_IN_TOOLS } from "./options.ts";

const launch = {
  executable: "/Users/person/.local/bin/claude",
  env: { HOME: "/Users/person", PATH: "/usr/bin" },
  cwd: "/private/localdot/claude-code/work",
};
const result = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"fits": 0.9}',
  usage: { input_tokens: 40, cache_read_input_tokens: 200, output_tokens: 9 },
  ...extra,
});
function fixture(messages: unknown[]) {
  const sent: { prompt: string; options: Options }[] = [];
  const closed = vi.fn();
  const query = vi.fn((params: { prompt: string; options: Options }) => {
    sent.push(params);
    return {
      close: closed,
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
    };
  });
  const read = vi.fn(async () => launch);
  const answer = claudeCodeAnswer(
    { query, launch: read, spawn: () => ({}) as SpawnedProcess },
    { model: "haiku", options: { reasoningEffort: "low" } },
  );
  return { answer, sent, closed, read };
}
const ask = (f: ReturnType<typeof fixture>, signal = new AbortController().signal) =>
  f.answer("Reply with JSON.", "Does this fit?", signal);

describe("a question for the fast model on the user's Claude Code plan", () => {
  it("is one turn with no tools, MCP servers, setup or saved session, and returns its answer and usage", async () => {
    const f = fixture([
      { type: "system", subtype: "init", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: '{"fits": 0.9}' }] } },
      result(),
    ]);
    expect(await ask(f)).toEqual({ text: '{"fits": 0.9}', inputTokens: 240, outputTokens: 9 });
    const [{ prompt, options }] = f.sent as [{ prompt: string; options: Options }];
    expect(prompt).toBe("Does this fit?");
    expect(options).toMatchObject({
      model: "haiku",
      effort: "low",
      systemPrompt: "Reply with JSON.",
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      cwd: launch.cwd,
      pathToClaudeCodeExecutable: launch.executable,
    });
    expect(options.disallowedTools).toEqual(BUILT_IN_TOOLS);
    expect(
      await options.canUseTool?.("mcp__localdot__computer", {}, {
        signal: new AbortController().signal,
        mcpServer: { name: "localdot", source: "sdk" },
      } as never),
    ).toMatchObject({ behavior: "deny" });
    expect(f.closed).toHaveBeenCalledOnce();
  });
  it("says when the plan served it at the fast speed", async () => {
    const fast = fixture([result({ usage: { input_tokens: 1, output_tokens: 1, speed: "fast" } })]);
    expect((await ask(fast)).speed).toBe("fast");
    const standard = fixture([
      result({ usage: { input_tokens: 1, output_tokens: 1, speed: "standard" } }),
    ]);
    expect(await ask(standard)).not.toHaveProperty("speed");
  });
  it.each([
    ["offers tools", [{ type: "system", subtype: "init", tools: ["Bash"] }, result()]],
    [
      "tries to use one",
      [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }, result()],
    ],
    ["fails", [result({ subtype: "error_during_execution", is_error: true, result: undefined })]],
    ["ends without an answer", []],
  ])("refuses an answer when Claude Code %s", async (_, messages) => {
    const f = fixture(messages);
    await expect(ask(f)).rejects.toThrow();
    expect(f.closed).toHaveBeenCalledOnce();
  });
  it("reads the launch once for the task, and again after a failed read", async () => {
    const f = fixture([result()]);
    f.read.mockRejectedValueOnce(new Error("signed out"));
    await expect(ask(f)).rejects.toThrow("signed out");
    await ask(f);
    await ask(f);
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("asks nothing once the check gave up", async () => {
    const f = fixture([result()]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(ask(f, stopped.signal)).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  });
});
