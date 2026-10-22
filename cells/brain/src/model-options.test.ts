import type { ModelBinding, ModelOptions } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { type AssistantContent, generateText, jsonSchema, type ModelMessage, tool } from "ai";
import { describe, expect, it } from "vitest";
import { settleOldTurns } from "./context.ts";
import { editsOlderTurns, languageModel } from "./models.ts";
import { binding } from "./testing/scripted.ts";

// Exercise each installed SDK, stopping at its network boundary. Expectations are HTTP fields,
// not the intermediate providerOptions object; a silently ignored option fails this test.
async function request(
  provider: string,
  modelId: string,
  options?: ModelOptions,
  max = 16000,
  extra: Partial<ModelBinding> = {},
) {
  const spec = providerById(provider);
  if (!spec) throw new Error(provider);
  let body: Record<string, unknown> | undefined;
  const model = languageModel(
    {
      ...binding(),
      provider,
      client: spec.client,
      route: spec.keyd === "openai-compatible" ? "custom-key" : spec.keyd,
      model: modelId,
      options,
      maxOutputTokens: 16000,
      ...extra,
    },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("captured request");
    },
  );
  if (typeof model === "string") throw new Error("Expected SDK model");
  await expect(
    model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "2 + 2?" }] }],
      maxOutputTokens: max,
    }),
  ).rejects.toThrow("captured request");
  return body;
}
const cases: [string, string, ModelOptions, Record<string, unknown>][] = [
  [
    "openai",
    "gpt-6-astra",
    { speed: "fast", reasoningEffort: "max" },
    { service_tier: "priority", reasoning: { effort: "max" } },
  ],
  ["openai", "gpt-6.1-sol", { speed: "standard" }, { service_tier: "default" }],
  [
    "openai",
    "gpt-6.1-sol",
    { speed: "ultrafast", reasoningEffort: "max" },
    { service_tier: "ultrafast", reasoning: { effort: "max" } },
  ],
  ["openai", "gpt-5.3-codex", { speed: "fast" }, { service_tier: "priority" }],
  [
    "anthropic",
    "claude-opus-5-5",
    { speed: "fast", reasoningEffort: "xhigh" },
    { speed: "fast", output_config: { effort: "xhigh" } },
  ],
  ["anthropic", "claude-opus-4-8", { speed: "standard" }, { speed: "standard" }],
  ["google", "gemini-3.8-flash", { speed: "fast" }, { serviceTier: "priority" }],
  [
    "xai",
    "grok-4.7",
    { speed: "fast", reasoningEffort: "xhigh" },
    { service_tier: "priority", reasoning: { effort: "xhigh" } },
  ],
  ["openrouter", "openai/gpt-6.1-sol", { speed: "ultrafast" }, { service_tier: "ultrafast" }],
  ["openrouter", "anthropic/claude-opus-4.8", { speed: "fast" }, { service_tier: "fast" }],
  [
    "openai",
    "gpt-6-astra",
    { reasoningEffort: "high", verbosity: "low" },
    { reasoning: { effort: "high" }, text: { verbosity: "low" }, store: false },
  ],
  [
    "azure",
    "gpt-5.4",
    { reasoningEffort: "xhigh" },
    { reasoning: { effort: "xhigh" }, store: false },
  ],
  [
    "openai-responses-compatible",
    "gpt-6.1-sol",
    { reasoningEffort: "max" },
    { reasoning: { effort: "max" }, store: false },
  ],
  [
    "openai-compatible",
    "gpt-5.4",
    { reasoningEffort: "low", verbosity: "high" },
    { reasoning_effort: "low", verbosity: "high" },
  ],
  [
    "anthropic",
    "claude-opus-4-7",
    { reasoningEffort: "xhigh" },
    { thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } },
  ],
  [
    "anthropic-compatible",
    "claude-sonnet-4-5",
    { thinkingBudget: 4096 },
    { thinking: { type: "enabled", budget_tokens: 4096 }, max_tokens: 16000 },
  ],
  [
    "google",
    "gemini-3.1-pro-preview",
    { reasoningEffort: "medium" },
    { generationConfig: { thinkingConfig: { thinkingLevel: "medium" } } },
  ],
  [
    "google",
    "gemini-2.5-flash",
    { thinkingBudget: 2048 },
    { generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } },
  ],
  [
    "xai",
    "grok-4.7",
    { reasoningEffort: "xhigh" },
    { reasoning: { effort: "xhigh" }, store: false },
  ],
  [
    "deepseek",
    "deepseek-flash",
    { reasoningEffort: "max" },
    { thinking: { type: "enabled" }, reasoning_effort: "max" },
  ],
  ["deepseek", "deepseek-flash", { reasoningEffort: "none" }, { thinking: { type: "disabled" } }],
  ["groq", "openai/gpt-oss-120b", { reasoningEffort: "high" }, { reasoning_effort: "high" }],
  ["mistral", "mistral-small-latest", { reasoningEffort: "none" }, { reasoning_effort: "none" }],
  [
    "openrouter",
    "anthropic/claude-opus-4.7",
    { reasoningEffort: "max" },
    { reasoning: { effort: "max" } },
  ],
  [
    "togetherai",
    "moonshotai/Kimi-K3",
    { reasoningEffort: "enabled" },
    { reasoning: { enabled: true } },
  ],
  [
    "fireworks-ai",
    "accounts/fireworks/models/deepseek-v3p2",
    { reasoningEffort: "enabled" },
    { reasoning_effort: "medium" },
  ],
  [
    "volcengine",
    "doubao-seed-2-1-pro-260915",
    { reasoningEffort: "low" },
    { thinking: { type: "enabled" }, reasoning_effort: "low" },
  ],
  [
    "cohere",
    "command-a-reasoning-08-2025",
    { reasoningEffort: "high" },
    { reasoning_effort: "high" },
  ],
  ["cerebras", "gpt-oss-120b", { reasoningEffort: "low" }, { reasoning_effort: "low" }],
  [
    "deepinfra",
    "moonshotai/Kimi-K3",
    { reasoningEffort: "medium" },
    { reasoning_effort: "medium" },
  ],
  ...["moonshotai", "moonshotai-cn"].map(
    (p): [string, string, ModelOptions, Record<string, unknown>] => [
      p,
      "kimi-k2.6",
      { reasoningEffort: "none" },
      { thinking: { type: "disabled" } },
    ],
  ),
  ...["alibaba", "alibaba-cn", "alibaba-token-plan", "alibaba-coding-plan"].map(
    (p): [string, string, ModelOptions, Record<string, unknown>] => [
      p,
      "qwen3.6-plus",
      { thinkingBudget: 2048 },
      { enable_thinking: true, thinking_budget: 2048 },
    ],
  ),
  ...["siliconflow", "siliconflow-cn"].map(
    (p): [string, string, ModelOptions, Record<string, unknown>] => [
      p,
      "Qwen/Qwen3-32B",
      { reasoningEffort: "none" },
      { enable_thinking: false },
    ],
  ),
  ...["zai", "zhipuai"].map((p): [string, string, ModelOptions, Record<string, unknown>] => [
    p,
    "glm-5.2",
    { reasoningEffort: "none" },
    { thinking: { type: "disabled" } },
  ]),
  ...["minimax", "minimax-coding-plan"].map(
    (p): [string, string, ModelOptions, Record<string, unknown>] => [
      p,
      "MiniMax-M3.1-Flash-Preview",
      { reasoningEffort: "max" },
      { reasoning_effort: "max" },
    ],
  ),
  ["ollama", "gpt-oss:20b", { reasoningEffort: "high" }, { reasoning_effort: "high" }],
];
describe("model option wire contracts", () => {
  it.each(cases)("%s / %s sends options accepted by its endpoint", async (p, m, o, expected) => {
    expect(await request(p, m, o)).toMatchObject(expected);
  });
  it("does not exceed the total output cap with Anthropic's additive thinking budget", async () => {
    expect(
      await request("anthropic", "claude-sonnet-4-5", { thinkingBudget: 8192 }, 2000),
    ).toMatchObject({ max_tokens: 2000, thinking: { type: "enabled", budget_tokens: 1024 } });
  });
  it("sends no new settings for old configurations", async () => {
    const body = await request("deepseek", "deepseek-flash");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });
});

describe("speed on the wire", () => {
  it("gives an OpenAI-format endpoint that takes speed tiers the tier, whatever its model is called", async () => {
    const controls: Partial<ModelBinding> = {
      controls: { efforts: [], speeds: ["standard", "fast", "ultrafast"] },
    };
    expect(
      await request(
        "openai-responses-compatible",
        "house-model",
        { speed: "fast" },
        16000,
        controls,
      ),
    ).toMatchObject({ service_tier: "priority" });
    expect(
      await request(
        "openai-responses-compatible",
        "gpt-6.1-sol",
        { speed: "ultrafast" },
        16000,
        controls,
      ),
    ).toMatchObject({ service_tier: "ultrafast" });
    expect(
      await request("openai-compatible", "house-model", { speed: "fast" }, 16000, {
        controls: { efforts: [], speeds: ["standard", "fast"] },
      }),
    ).toMatchObject({ service_tier: "priority" });
    const plain = await request(
      "openai-responses-compatible",
      "house-model",
      undefined,
      16000,
      controls,
    );
    expect(plain).not.toHaveProperty("service_tier");
    await expect(
      request("openai-responses-compatible", "house-model", { speed: "fast" }),
    ).rejects.toThrow(/Speed selection is not supported/);
  });
  it("holds an OpenRouter premium request to the rate the task set aside", async () => {
    expect(
      await request("openrouter", "google/gemini-3.6-flash", { speed: "fast" }, 16000, {
        maxPrice: { inputUSDPerMTok: 0.9, outputUSDPerMTok: 5.4 },
      }),
    ).toMatchObject({
      service_tier: "fast",
      provider: { max_price: { prompt: 0.9, completion: 5.4 } },
    });
  });
  it("asks Anthropic for fast mode with the beta it requires", async () => {
    let beta = "";
    const model = languageModel(
      {
        ...binding(),
        provider: "anthropic",
        client: "anthropic",
        route: "anthropic",
        model: "claude-opus-4-8",
        options: { speed: "fast" },
        maxOutputTokens: 16000,
      },
      async (_url, init) => {
        beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
        throw new Error("captured request");
      },
    );
    await expect(generateText({ model, prompt: "2 + 2?", maxRetries: 0 })).rejects.toThrow();
    expect(beta).toContain("fast-mode-2026-02-01");
  });
});

type ReasoningPart = Extract<Exclude<AssistantContent, string>[number], { type: "reasoning" }>;

describe("older reasoning on the wire", () => {
  // A task's turns as each SDK returned them: reasoning, a tool call, then the tool's result.
  const history = (reasoning: (k: number) => ReasoningPart): ModelMessage[] => [
    { role: "user", content: "Research the topic" },
    ...Array.from({ length: 24 }, (_, k): ModelMessage[] => [
      {
        role: "assistant",
        content: [
          reasoning(k),
          { type: "tool-call", toolCallId: `call_${k}`, toolName: "shell", input: { k } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call_${k}`,
            toolName: "shell",
            output: { type: "text", value: `ran ${k}` },
          },
        ],
      },
    ]).flat(),
  ];
  async function wire(over: Partial<ModelBinding>, messages: ModelMessage[]) {
    const b = { ...binding(), computer: "generic" as const, ...over };
    expect(editsOlderTurns(b)).toBe(true);
    let body: Record<string, unknown> | undefined;
    const model = languageModel(b, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("captured request");
    });
    await expect(
      generateText({
        model,
        messages: settleOldTurns(messages),
        tools: { shell: tool({ inputSchema: jsonSchema({ type: "object" }) }) },
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    return body as Record<string, unknown>;
  }

  it("sends DeepSeek V4 an empty reasoning_content for older turns", async () => {
    const body = await wire(
      { route: "deepseek", client: "deepseek", model: "deepseek-flash", reasoning: true },
      history((k) => ({ type: "reasoning", text: `[thought-${k}]` })),
    );
    const assistants = (body.messages as { role: string; reasoning_content?: string }[]).filter(
      (m) => m.role === "assistant",
    );
    expect(assistants.map((m) => m.reasoning_content)).toEqual([
      ...Array.from({ length: 16 }, () => ""),
      ...Array.from({ length: 8 }, (_, k) => `[thought-${16 + k}]`),
    ]);
  });

  it.each(["openai", "azure"] as const)(
    "sends the stateless %s Responses API no item for older reasoning and no call item ids",
    async (client) => {
      const body = await wire(
        { route: client, client, model: "gpt-5.4", reasoning: true },
        history((k) => ({
          type: "reasoning",
          text: "",
          providerOptions: {
            [client]: { itemId: `rs_${k}`, reasoningEncryptedContent: `enc-${k}` },
          },
        })),
      );
      const input = body.input as { type?: string; id?: string; encrypted_content?: string }[];
      expect(body.store).toBe(false);
      expect(
        input.flatMap((item) =>
          item.type === "reasoning" ? [[item.id, item.encrypted_content]] : [],
        ),
      ).toEqual(Array.from({ length: 8 }, (_, k) => [`rs_${16 + k}`, `enc-${16 + k}`]));
      const calls = input.filter((item) => item.type === "function_call");
      expect(calls).toHaveLength(24);
      for (const call of calls) expect(call).not.toHaveProperty("id");
    },
  );
});

describe("a Claude conversation whose earlier turns changed", () => {
  const BOUND =
    "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.";
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const answer = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "4" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  function claude(refuse: (body: Record<string, unknown>) => string | undefined) {
    const spec = providerById("anthropic");
    if (!spec) throw new Error("anthropic");
    const sent: { body: Record<string, unknown>; beta: string }[] = [];
    const model = languageModel(
      {
        ...binding(),
        provider: "anthropic",
        client: spec.client,
        route: spec.keyd,
        model: "claude-sonnet-4-5",
        maxOutputTokens: 16000,
      },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push({ body, beta: new Headers(init?.headers).get("anthropic-beta") ?? "" });
        const why = refuse(body);
        return why
          ? reply(400, { type: "error", error: { type: "invalid_request_error", message: why } })
          : reply(200, answer);
      },
    );
    return { model, sent };
  }

  it("is sent again with the thinking that no longer fits dropped, and so is every later call", async () => {
    const { model, sent } = claude((body) =>
      (body.thinking as { block_binding?: unknown } | undefined)?.block_binding ? undefined : BOUND,
    );
    expect((await generateText({ model, prompt: "2 + 2?", maxRetries: 0 })).text).toBe("4");
    expect((await generateText({ model, prompt: "3 + 3?", maxRetries: 0 })).text).toBe("4");
    expect(sent.map((s) => s.body.thinking)).toEqual([
      undefined,
      { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    ]);
    expect(
      sent.slice(1).every((s) => s.beta.includes("thinking-binding-controls-2026-08-01")),
    ).toBe(true);
  });

  it("leaves a request the account accepts, and any other refusal, as they were", async () => {
    const fine = claude(() => undefined);
    await generateText({ model: fine.model, prompt: "2 + 2?", maxRetries: 0 });
    expect(fine.sent).toHaveLength(1);
    expect(fine.sent[0]?.body).not.toHaveProperty("thinking");
    const other = claude(() => "max_tokens: 64000 > 32000, the maximum for this model");
    await expect(
      generateText({ model: other.model, prompt: "2 + 2?", maxRetries: 0 }),
    ).rejects.toThrow(/max_tokens/);
    expect(other.sent).toHaveLength(1);
  });
});
