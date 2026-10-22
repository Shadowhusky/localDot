import { ModelOptions } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  choiceControls,
  modelControls,
  modelOptionsProblem,
  modelProviderOptions,
  sameModelOptions,
} from "./model-options.ts";
import { PROVIDERS } from "./registry.ts";

describe("model controls", () => {
  it("separates speed from effort and does not leak direct API tiers to gateways", () => {
    expect(modelControls("claude-code", "sonnet").efforts).toContain("xhigh");
    expect(modelControls("claude-code", "opus").efforts).toContain("max");
    expect(modelControls("openai", "gpt-6-astra").speeds).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
    expect(modelControls("openai", "gpt-6-luna").speeds).toEqual(["standard", "fast"]);
    for (const provider of [
      "deepseek",
      "azure",
      "groq",
      "openai-compatible",
      "openai-responses-compatible",
      "openrouter",
    ])
      expect(modelOptionsProblem(provider, "gpt-6-astra", { speed: "fast" })).toBeTruthy();
    expect(modelOptionsProblem("anthropic", "claude-opus-4-7", { speed: "fast" })).toBeTruthy();
    expect(
      modelOptionsProblem("anthropic", "claude-opus-5-5", { speed: "ultrafast" }),
    ).toBeTruthy();
    expect(modelOptionsProblem("openai", "gpt-6-luna", { speed: "ultrafast" })).toBeTruthy();
    expect(sameModelOptions({ speed: "standard" }, { speed: "fast" })).toBe(false);
    expect(sameModelOptions({ speed: "fast" }, { speed: "ultrafast" })).toBe(false);
  });
  it("gives a custom endpoint speeds only when its user says it takes OpenAI's tiers", () => {
    const sol = { provider: "openai-responses-compatible", model: "gpt-6.1-sol" };
    expect(choiceControls(sol).speeds).toBeUndefined();
    expect(choiceControls({ ...sol, speedTiers: true }).speeds).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
    expect(choiceControls({ ...sol, speedTiers: true }).efforts).toEqual(
      modelControls(sol.provider, sol.model).efforts,
    );
    expect(
      choiceControls({ provider: "openai-compatible", model: "my-model", speedTiers: true }).speeds,
    ).toEqual(["standard", "fast"]);
    expect(
      choiceControls({ provider: "anthropic-compatible", model: "glm-5.3", speedTiers: true })
        .speeds,
    ).toBeUndefined();
  });
  it("names each speed in each provider's own words", () => {
    const wire = (provider: string, model: string, speed: "standard" | "fast" | "ultrafast") =>
      modelProviderOptions(provider, model, { speed });
    expect(wire("openai", "gpt-6.1-sol", "fast")).toEqual({ serviceTier: "priority" });
    expect(wire("openai", "gpt-6.1-sol", "ultrafast")).toEqual({ serviceTier: "ultrafast" });
    expect(wire("openai", "gpt-5.3-codex", "fast")).toEqual({ serviceTier: "priority" });
    expect(wire("openai", "gpt-6.1-sol", "standard")).toEqual({ serviceTier: "default" });
    expect(wire("anthropic", "claude-opus-5-5", "fast")).toEqual({ speed: "fast" });
    expect(wire("google", "gemini-3.8-flash", "fast")).toEqual({ serviceTier: "priority" });
    expect(wire("google", "gemini-3.8-flash", "standard")).toEqual({ serviceTier: "standard" });
    expect(wire("xai", "grok-4.7", "fast")).toEqual({ serviceTier: "priority" });
    expect(wire("openrouter", "openai/gpt-6.1-sol", "ultrafast")).toEqual({
      service_tier: "ultrafast",
    });
    expect(
      modelProviderOptions(
        "openai-responses-compatible",
        "my-model",
        { speed: "ultrafast" },
        { efforts: [], speeds: ["standard", "fast", "ultrafast"] },
      ),
    ).toEqual({ serviceTier: "ultrafast" });
    expect(
      modelProviderOptions(
        "openai-compatible",
        "my-model",
        { speed: "fast" },
        { efforts: [], speeds: ["standard", "fast"] },
      ),
    ).toEqual({ service_tier: "priority" });
  });
  it("caps an OpenRouter premium request at the rate the task set aside", () => {
    const cap = { inputUSDPerMTok: 8, outputUSDPerMTok: 30 };
    expect(
      modelProviderOptions(
        "openrouter",
        "anthropic/claude-opus-4.8",
        { speed: "fast", reasoningEffort: "high" },
        undefined,
        cap,
      ),
    ).toEqual({
      service_tier: "fast",
      provider: { max_price: { prompt: 8, completion: 30 } },
      reasoning: { effort: "high" },
    });
    expect(
      modelProviderOptions(
        "openrouter",
        "anthropic/claude-opus-4.8",
        { speed: "standard" },
        undefined,
        cap,
      ),
    ).toEqual({ service_tier: "default" });
  });
  it.each(PROVIDERS.map((p) => p.id))(
    "%s preserves provider defaults and rejects invented controls",
    (provider) => {
      expect(modelProviderOptions(provider, "unknown-model")).toEqual({});
      expect(modelProviderOptions(provider, "unknown-model", {})).toEqual({});
      expect(
        modelOptionsProblem(provider, "unknown-model", { reasoningEffort: "high" }),
      ).toBeTruthy();
    },
  );
  it("distinguishes effort vocabularies, mandatory thinking and endpoint contracts", () => {
    expect(modelControls("openai", "gpt-6-astra").efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelControls("openai", "gpt-6-luna").efforts).toContain("none");
    expect(modelControls("openai-compatible", "gpt-6-luna").efforts).toEqual(["none"]);
    expect(modelControls("openai-responses-compatible", "gpt-6-luna").efforts).toContain("max");
    expect(modelControls("google", "gemini-3-pro-preview").efforts).toEqual(["low", "high"]);
    expect(modelControls("google", "gemini-2.5-pro").efforts).not.toContain("none");
    expect(modelControls("anthropic", "claude-opus-4-6").efforts).not.toContain("xhigh");
    expect(modelControls("anthropic", "claude-opus-4-7").efforts).toContain("xhigh");
    expect(modelControls("deepseek", "deepseek-flash").efforts).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
    expect(modelControls("zai", "glm-5.3").efforts).toEqual([]);
    expect(modelControls("siliconflow", "deepseek-ai/DeepSeek-V3.1").efforts).toEqual(["none"]);
  });
  it("rejects unsafe or contradictory configuration and preserves the output reserve", () => {
    for (const options of [
      { reasoningEffort: "extreme" },
      { speed: "priority" },
      { temperature: 1 },
      { thinkingBudget: -1 },
      { reasoningEffort: "high", thinkingBudget: 2048 },
    ])
      expect(ModelOptions.safeParse(options).success).toBe(false);
    expect(
      modelOptionsProblem("anthropic", "claude-sonnet-4-5", { thinkingBudget: 4096 }, 4096),
    ).toBeTruthy();
    expect(
      modelOptionsProblem("anthropic", "claude-sonnet-4-5", { thinkingBudget: 2048 }, 4096),
    ).toBeUndefined();
    expect(modelOptionsProblem("deepseek", "deepseek-flash", { verbosity: "low" })).toBeTruthy();
  });
  it("compares option values independently of object identity and key order", () => {
    expect(sameModelOptions(undefined, {})).toBe(true);
    expect(sameModelOptions({ reasoningEffort: "low" }, { reasoningEffort: "high" })).toBe(false);
    expect(
      sameModelOptions(
        { reasoningEffort: "high", verbosity: "low" },
        { verbosity: "low", reasoningEffort: "high" },
      ),
    ).toBe(true);
  });
});
