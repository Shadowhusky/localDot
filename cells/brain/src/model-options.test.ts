import type { ModelOptions } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { describe, expect, it } from "vitest";
import { languageModel } from "./models.ts";
import { binding } from "./testing/scripted.ts";

// Exercise each installed SDK, stopping at its network boundary. Expectations are HTTP fields,
// not the intermediate providerOptions object; a silently ignored option fails this test.
async function request(provider: string, modelId: string, options?: ModelOptions, max = 16000) {
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
