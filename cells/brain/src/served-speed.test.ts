import type { ClientKind } from "@localdot/protocol";
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { languageModel, rawTier, servedTier } from "./models.ts";
import { binding } from "./testing/scripted.ts";

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
const responses = (tier: string) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-6.1-sol",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  service_tier: tier,
});
const chat = (tier: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "house-model",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  service_tier: tier,
});

// As the brain reads a summary's answer: the provider's metadata, Gemini's header, or the
// service_tier of an OpenAI-style chat completion.
async function served(provider: string, client: ClientKind, model: string, reply: Response) {
  const result = await generateText({
    model: languageModel(
      {
        ...binding(),
        provider,
        client,
        route: provider === "openai-compatible" ? "custom-key" : client,
        model,
      },
      async () => reply,
    ),
    prompt: "2 + 2?",
    maxRetries: 0,
    include: { responseBody: true },
  });
  return servedTier(
    result.providerMetadata,
    result.response.headers,
    rawTier(result.response.body),
  );
}

describe("the speed a provider says served a call", () => {
  it("reads OpenAI's and xAI's service tier", async () => {
    expect(await served("openai", "openai", "gpt-6.1-sol", json(responses("priority")))).toBe(
      "fast",
    );
    expect(await served("openai", "openai", "gpt-6.1-sol", json(responses("ultrafast")))).toBe(
      "ultrafast",
    );
    // Asked for Fast, served at the standard tier: billed and shown as standard.
    expect(await served("openai", "openai", "gpt-6.1-sol", json(responses("default")))).toBe(
      undefined,
    );
    expect(
      await served("xai", "xai", "grok-4.7", json({ ...responses("priority"), model: "grok-4.7" })),
    ).toBe("fast");
  });
  it("reads Anthropic's usage speed", async () => {
    const message = (speed: string) => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, speed },
    });
    expect(await served("anthropic", "anthropic", "claude-opus-4-8", json(message("fast")))).toBe(
      "fast",
    );
    expect(
      await served("anthropic", "anthropic", "claude-opus-4-8", json(message("standard"))),
    ).toBe(undefined);
  });
  it("reads Gemini's service tier header", async () => {
    const answer = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };
    expect(
      await served(
        "google",
        "google",
        "gemini-3.8-flash",
        json(answer, { "x-gemini-service-tier": "priority" }),
      ),
    ).toBe("fast");
    expect(await served("google", "google", "gemini-3.8-flash", json(answer))).toBe(undefined);
  });
  it("reads the service tier of an OpenAI-style chat completion", async () => {
    expect(
      await served("openai-compatible", "openai-compatible", "house-model", json(chat("priority"))),
    ).toBe("fast");
    expect(
      await served("openrouter", "openrouter", "openai/gpt-6.1-sol", json(chat("ultrafast"))),
    ).toBe("ultrafast");
  });
  it("reads it from a streamed chat completion's chunks, as a turn is read", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "openai/gpt-6.1-sol",
      service_tier: "priority",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const sse = `${[chunk({ role: "assistant", content: "ok" }, null), chunk({}, "stop")]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")}data: [DONE]\n\n`;
    const result = streamText({
      model: languageModel(
        {
          ...binding(),
          provider: "openrouter",
          client: "openrouter",
          route: "openrouter",
          model: "openai/gpt-6.1-sol",
        },
        async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      ),
      prompt: "2 + 2?",
      maxRetries: 0,
      includeRawChunks: true,
    });
    let chatTier: unknown, speed: unknown;
    for await (const part of result.fullStream) {
      if (part.type === "raw") chatTier = rawTier(part.rawValue) ?? chatTier;
      else if (part.type === "finish-step")
        speed = servedTier(part.providerMetadata, part.response.headers, chatTier);
    }
    expect(speed).toBe("fast");
  });
});
