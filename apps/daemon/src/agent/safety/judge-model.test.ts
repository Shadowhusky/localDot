import type { ModelBinding } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { completionCall, gatewayCompletion } from "./judge-model.ts";

const SURROGATE = `ld_ant_${"a".repeat(22)}_${"b".repeat(6)}`;
const binding = (client: ModelBinding["client"], model = "m-1"): ModelBinding => ({
  route: "fast-route",
  client,
  model,
  surrogate: SURROGATE,
  computer: "generic",
  coords: "pixels",
  vision: false,
  reasoning: false,
  contextTokens: 32_768,
  maxOutputTokens: 4096,
});

describe("the fast model as judge", () => {
  it("asks each provider in its own API, with keyd's stand-in in its own header", () => {
    const anthropic = completionCall(binding("anthropic"), "sys", "prompt");
    expect(anthropic).toMatchObject({
      path: "messages",
      headers: { "x-api-key": SURROGATE },
      body: { model: "m-1", system: "sys", messages: [{ role: "user", content: "prompt" }] },
    });
    expect(anthropic.read({ content: [{ type: "text", text: '{"fits":1}' }] })).toBe('{"fits":1}');
    const openai = completionCall(binding("openai"), "sys", "prompt");
    expect(openai).toMatchObject({
      path: "responses",
      headers: { authorization: `Bearer ${SURROGATE}` },
      body: { instructions: "sys", input: "prompt", store: false },
    });
    expect(openai.read({ output: [{ content: [{ type: "output_text", text: "ok" }] }] })).toBe(
      "ok",
    );
    const google = completionCall(binding("google", "gemini-x"), "sys", "prompt");
    expect(google.path).toBe("models/gemini-x:generateContent");
    expect(google.read({ candidates: [{ content: { parts: [{ text: "g" }] } }] })).toBe("g");
    const chat = completionCall(binding("deepseek"), "sys", "prompt");
    expect(chat.path).toBe("chat/completions");
    expect(chat.read({ choices: [{ message: { content: "c" } }] })).toBe("c");
  });

  it("goes through the task's keyd gateway route, and fails while no model runs", async () => {
    const fetch = vi.fn(
      async (_url: string, _init: unknown) =>
        new Response(JSON.stringify({ choices: [{ message: { content: "yes" } }] }), {
          status: 200,
        }),
    );
    const complete = gatewayCompletion(
      () => binding("groq"),
      () => ({ port: 4788, token: "t".repeat(43) }),
      fetch as never,
    );
    expect(await complete("sys", "prompt", new AbortController().signal)).toBe("yes");
    expect(fetch.mock.calls[0]?.[0]).toBe("http://llm.ldot/fast-route/chat/completions");
    const idle = gatewayCompletion(
      () => undefined,
      () => undefined,
      fetch as never,
    );
    await expect(idle("sys", "prompt", new AbortController().signal)).rejects.toThrow();
  });

  it("stops reading an answer once it is too large", async () => {
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024)),
      });
    const listener = () => ({ port: 4788, token: "t".repeat(43) });
    const streamed = gatewayCompletion(
      () => binding("groq"),
      listener,
      (async () => new Response(endless(), { status: 200 })) as never,
    );
    await expect(streamed("sys", "prompt", new AbortController().signal)).rejects.toThrow(
      "too large",
    );
    const declared = gatewayCompletion(
      () => binding("groq"),
      listener,
      (async () =>
        new Response(endless(), {
          status: 200,
          headers: { "content-length": String(1 << 30) },
        })) as never,
    );
    await expect(declared("sys", "prompt", new AbortController().signal)).rejects.toThrow(
      "too large",
    );
  });

  it("turns thinking down in each API's own words, only where the model takes that level", () => {
    const of = (provider: string, client: ModelBinding["client"], model: string) => ({
      ...binding(client, model),
      provider,
    });
    const body = (b: ModelBinding, effort: Parameters<typeof completionCall>[4]) =>
      completionCall(b, "sys", "prompt", undefined, effort).body as Record<string, unknown>;
    expect(body(of("openai", "openai", "gpt-5-mini"), "minimal")).toMatchObject({
      reasoning: { effort: "minimal" },
    });
    expect(body(of("groq", "groq", "openai/gpt-oss-120b"), "low")).toMatchObject({
      reasoning_effort: "low",
    });
    expect(body(of("deepseek", "deepseek", "deepseek-chat"), "none")).toMatchObject({
      thinking: { type: "disabled" },
    });
    expect(body(of("google", "google", "gemini-2.5-flash"), "none")).toMatchObject({
      generationConfig: { maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(body(of("google", "google", "gemini-3-flash"), "minimal")).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
    const plain = body(of("anthropic", "anthropic", "claude-haiku-4-5"), "none");
    expect(plain).not.toHaveProperty("thinking");
    // A level the model doesn't offer, or no level, leaves the request as it was.
    expect(body(of("openai", "openai", "gpt-5-mini"), "none")).not.toHaveProperty("reasoning");
    expect(body(of("openai", "openai", "gpt-5-mini"), undefined)).not.toHaveProperty("reasoning");
  });
});

describe("visual target requests", () => {
  it.each([
    "anthropic",
    "anthropic-compatible",
    "google",
    "openai",
    "azure",
    "xai",
    "deepseek",
  ] as const)("attaches PNG evidence in %s's native format", (client) => {
    const b = { ...binding(client), vision: true };
    const call = completionCall(b, "sys", "target", "cGl4ZWxz");
    const body = JSON.stringify(call.body);
    expect(body).toContain("cGl4ZWxz");
    expect(body).toContain("target");
    expect(body).toContain("image");
    expect(call.headers).not.toHaveProperty("image");
  });
});
