import type { ModelBinding } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { ModelAnswerError } from "../safety/judge-model.ts";
import type { SideToolSpec } from "./tools.ts";
import { type SideMessage, sideCall, sideStep } from "./wire.ts";

const SURROGATE = `ld_ant_${"a".repeat(22)}_${"b".repeat(6)}`;
const binding = (client: string): ModelBinding =>
  ({ client, model: "m1", route: "r1", surrogate: SURROGATE, provider: "p" }) as ModelBinding;
const TOOL: SideToolSpec = {
  name: "read_log",
  description: "Reads",
  schema: { type: "object", properties: { last: { type: "number" } } },
};
const CALL = { id: "c1", name: "read_log", input: { last: 2 } };
const conversation = (raw: unknown): SideMessage[] => [
  { role: "user", text: "Question" },
  {
    role: "assistant",
    step: { text: "Looking", calls: [CALL], raw, inputTokens: 1, outputTokens: 1 },
  },
  {
    role: "tools",
    results: [
      {
        call: CALL,
        result: {
          ok: true,
          text: "Result",
          images: [{ data: "AAAA", mediaType: "image/png" }],
        },
      },
    ],
  },
];
const body = (client: string, raw: unknown) =>
  sideCall(binding(client), "SYS", conversation(raw), [TOOL]).body as Record<string, unknown>;

describe("each provider's own tool format", () => {
  it("speaks Anthropic's, sending its turn back as it came", () => {
    const raw = [
      { type: "thinking", thinking: "t", signature: "sig" },
      { type: "tool_use", id: "c1", name: "read_log", input: { last: 2 } },
    ];
    const sent = body("anthropic", raw);
    expect(sent.system).toBe("SYS");
    expect(sent.tools).toEqual([
      { name: "read_log", description: "Reads", input_schema: TOOL.schema },
    ]);
    expect((sent.messages as unknown[])[1]).toEqual({ role: "assistant", content: raw });
    expect((sent.messages as unknown[])[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: [
            { type: "text", text: "Result" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    });
    const read = sideCall(binding("anthropic"), "S", [], [TOOL]).read({
      content: [
        { type: "text", text: "Hi" },
        { type: "tool_use", id: "c2", name: "finish", input: { status: "found" } },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    });
    expect(read).toMatchObject({
      text: "Hi",
      calls: [{ id: "c2", name: "finish", input: { status: "found" } }],
      inputTokens: 15,
      outputTokens: 3,
    });
  });

  it("speaks Google's, with its signed parts as they came", () => {
    const raw = [{ functionCall: { name: "read_log", args: { last: 2 } }, thoughtSignature: "s" }];
    const sent = body("google", raw);
    expect(sent.tools).toEqual([
      {
        functionDeclarations: [{ name: "read_log", description: "Reads", parameters: TOOL.schema }],
      },
    ]);
    expect((sent.contents as unknown[])[1]).toEqual({ role: "model", parts: raw });
    expect((sent.contents as unknown[])[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "read_log", response: { output: "Result" } } },
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
      ],
    });
    const read = sideCall(binding("google"), "S", [], [TOOL]).read({
      candidates: [
        {
          content: {
            parts: [{ text: "Hi" }, { functionCall: { name: "finish", args: { a: 1 } } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
    });
    expect(read).toMatchObject({
      text: "Hi",
      calls: [{ name: "finish", input: { a: 1 } }],
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("speaks the Responses API, streaming as Codex-backed endpoints insist", () => {
    const sent = body("openai", []);
    expect(sent.stream).toBe(true);
    expect(sent.store).toBe(false);
    expect(sent.tools).toEqual([
      {
        type: "function",
        name: "read_log",
        description: "Reads",
        parameters: TOOL.schema,
        strict: false,
      },
    ]);
    expect((sent.input as unknown[]).slice(1)).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "Looking" }] },
      { type: "function_call", call_id: "c1", name: "read_log", arguments: '{"last":2}' },
      { type: "function_call_output", call_id: "c1", output: "Result" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "The picture that tool returned:" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("speaks chat completions, keeping a model's own fields on its turn", () => {
    const raw = { role: "assistant", content: "", reasoning_content: "r", tool_calls: [] };
    const sent = body("deepseek", raw);
    expect((sent.messages as unknown[])[0]).toEqual({ role: "system", content: "SYS" });
    expect((sent.messages as unknown[])[2]).toEqual(raw);
    expect((sent.messages as unknown[])[3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "Result",
    });
    expect((sent.messages as { role?: string }[])[4]?.role).toBe("user");
    const read = sideCall(binding("deepseek"), "S", [], [TOOL]).read({
      choices: [
        {
          message: {
            content: "Hi",
            tool_calls: [{ id: "c9", function: { name: "finish", arguments: '{"a":1}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
    expect(read).toMatchObject({
      calls: [{ id: "c9", name: "finish", input: { a: 1 } }],
      inputTokens: 4,
      outputTokens: 2,
    });
    expect((read.raw as { reasoning_content?: string }).reasoning_content).toBeUndefined();
  });

  it("takes arguments it can't read as empty, for the tool's own check to refuse", () => {
    const read = sideCall(binding("deepseek"), "S", [], [TOOL]).read({
      choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "{oops" } }] } }],
    });
    expect(read.calls[0]).toMatchObject({ id: "call_0", input: {} });
  });
});

function reply(text: string, type = "application/json", status = 200) {
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, { status, headers: { "content-type": type } });
}
const asked = (answer: Response, client = "openai") =>
  sideStep(
    binding(client),
    { port: 4788, token: "t" },
    "S",
    [{ role: "user", text: "Q" }],
    [TOOL],
    new AbortController().signal,
    undefined,
    vi.fn(async () => answer) as never,
  );

describe("a reply", () => {
  it("gathers a Responses stream into its calls and usage", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "Hello" },
      {
        type: "response.completed",
        response: {
          output: [
            { type: "message", content: [{ type: "output_text", text: "Hello" }] },
            {
              type: "function_call",
              call_id: "c3",
              name: "finish",
              arguments: '{"status":"found"}',
            },
          ],
          usage: { input_tokens: 9, output_tokens: 2 },
        },
      },
    ];
    const step = await asked(
      reply(events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n"), "text/event-stream"),
    );
    expect(step).toMatchObject({
      text: "Hello",
      calls: [{ id: "c3", name: "finish", input: { status: "found" } }],
      inputTokens: 9,
      outputTokens: 2,
    });
  });

  it("gathers a relay's stream of chat completions, whatever it's labelled", async () => {
    const events = [
      { choices: [{ delta: { content: "Hi" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c4", function: { name: "finish", arguments: '{"sta' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'tus":"found"}' } }] } },
        ],
      },
      { choices: [], usage: { prompt_tokens: 6, completion_tokens: 1 } },
    ];
    const step = await asked(
      reply(`${events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n")}\ndata: [DONE]\n`),
      "deepseek",
    );
    expect(step).toMatchObject({
      text: "Hi",
      calls: [{ id: "c4", name: "finish", input: { status: "found" } }],
      inputTokens: 6,
    });
  });

  it("says what failed mid-stream", async () => {
    await expect(
      asked(
        reply(
          `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Overloaded" } } })}\n`,
          "text/event-stream",
        ),
      ),
    ).rejects.toMatchObject({ reason: "Overloaded" });
  });

  it("refuses an answer it can't read", async () => {
    await expect(asked(reply("not json"))).rejects.toBeInstanceOf(ModelAnswerError);
  });

  it("names which limit keyd stopped it at", async () => {
    await expect(
      asked(
        reply(
          JSON.stringify({ error: { type: "budget_exceeded", scope: "task", limitUSD: 0.1 } }),
          "application/json",
          402,
        ),
      ),
    ).rejects.toMatchObject({ status: 402, reason: "budget_exceeded task" });
  });
});
