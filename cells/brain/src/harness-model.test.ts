import { createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { driveHarness } from "./harness.ts";
import { harnessModel } from "./harness-model.ts";

it("preserves provider reasoning signatures and tool identities through native child replay", async () => {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "reasoning-start", id: "r" },
            {
              type: "reasoning-delta",
              id: "r",
              delta: "private reasoning",
              providerMetadata: { anthropic: { signature: "signed-replay-fixture" } },
            },
            {
              type: "reasoning-end",
              id: "r",
              providerMetadata: { anthropic: { signature: "signed-replay-fixture" } },
            },
            {
              type: "tool-call",
              toolCallId: "read-source",
              toolName: "web_fetch",
              input: '{"url":"https://example.com"}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 5, text: 2, reasoning: 3 },
              },
            },
          ],
        }),
      };
    },
  });
  const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
    const out: T[] = [];
    for await (const value of source) out.push(value);
    return out;
  };
  const options = {
    provider: "localdot",
    model: "configured",
    system: "Trusted provider policy",
    messages: [
      { role: "system", content: [{ type: "text", text: "Trusted native child persona" }] },
      createUserMessage({
        content: [{ type: "text", text: "Research" }],
        source: { kind: "user" },
      }),
    ],
    tools: [
      {
        name: "web_fetch",
        description: "Read a source",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
    ],
    maxTokens: 128,
  } as GenerateOptions;
  const usage = vi.fn();
  const chunks = await collect(harnessModel(options, model, usage));
  for (const chunk of chunks) expect(chunk).toStrictEqual(JSON.parse(JSON.stringify(chunk)));
  const finish = chunks.find((chunk) => chunk.type === "finish");
  expect(finish?.type === "finish" && finish.replayState).toBeTruthy();
  expect(usage).toHaveBeenCalledWith(10, 5);
  expect(chunks).toContainEqual(
    expect.objectContaining({
      type: "block-end",
      block: expect.objectContaining({ type: "tool-call", id: "read-source", name: "web_fetch" }),
    }),
  );
  await collect(
    harnessModel(
      {
        ...options,
        messages: [
          ...options.messages,
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "read-source",
                name: "web_fetch",
                arguments: '{"url":"https://example.com"}',
              },
            ],
            source: { replayState: finish?.type === "finish" ? finish.replayState : undefined },
          },
          {
            role: "tool",
            toolCallId: "read-source",
            content: [{ type: "text", text: "Untrusted source" }],
          },
        ],
      } as GenerateOptions,
      model,
      usage,
    ),
  );
  expect(JSON.stringify(prompts[0])).toContain(
    "Trusted provider policy\\n\\nTrusted native child persona",
  );
  const replay = JSON.stringify(prompts[1]);
  expect(replay).toContain("signed-replay-fixture");
  expect(replay).toContain("read-source");
  expect(replay).toContain('"toolName":"web_fetch"');
});

it("runs the real SDK bridge through native child journaling, tools and completion", async () => {
  let childTurns = 0,
    parentTurns = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...(childTurns++ === 0
            ? [
                {
                  type: "tool-call",
                  toolCallId: "fetch",
                  toolName: "web_fetch",
                  input: '{"url":"https://example.com"}',
                },
              ]
            : [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "SDK_CHILD_VERIFIED" },
                { type: "text-end", id: "t" },
              ]),
          {
            type: "finish",
            finishReason: { unified: childTurns === 1 ? "tool-calls" : "stop", raw: undefined },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
          },
        ] as never[],
      }),
    }),
  });
  const content = [{ type: "text" as const, text: "Verified public source" }];
  const executeChild = vi.fn(async () => ({ ok: true, content }));
  await driveHarness({
    sessionId: "sdk-parent",
    task: "Research with a child",
    signal: new AbortController().signal,
    delegation: {
      tools: [
        {
          name: "web_fetch",
          description: "Read a source",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      ],
      execute: executeChild,
      request: (options) => harnessModel(options, model, () => {}),
    },
    request: async () =>
      ++parentTurns === 1
        ? {
            text: "",
            calls: [
              {
                id: "delegate",
                name: "subagent",
                input: {
                  description: "Research",
                  prompt: "Read a public source",
                  run_in_background: false,
                },
              },
            ],
          }
        : { text: "", calls: [{ id: "done", name: "done", input: {} }] },
    execute: async (id, _signal, native) => {
      if (id === "delegate") {
        expect(native?.ok, JSON.stringify(native)).toBe(true);
        expect(JSON.stringify(native?.content)).toContain("SDK_CHILD_VERIFIED");
      }
      return { result: native ?? { ok: true, content }, conclude: id === "done" };
    },
    stopping: async () => false,
  });
  expect(childTurns).toBe(2);
  expect(executeChild).toHaveBeenCalledTimes(1);
});
