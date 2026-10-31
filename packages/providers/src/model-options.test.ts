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
    expect(modelControls("zai", "glm-5.3").efforts).toEqual(["low", "high", "max"]);
    expect(modelControls("siliconflow", "deepseek-ai/DeepSeek-V3.1").efforts).toEqual(["none"]);
  });
  it("offers each family the levels its provider's documentation lists (2026-10-31)", () => {
    const levels = (provider: string, model: string) => modelControls(provider, model).efforts;
    for (const provider of ["moonshotai", "moonshotai-cn"]) {
      expect(levels(provider, "kimi-k3.1-pro")).toEqual(["low", "high", "max"]);
      expect(levels(provider, "kimi-k3.1-pro-highspeed")).toEqual(["low", "high", "max"]);
      expect(levels(provider, "kimi-k3")).toEqual(["low", "high", "max"]);
      expect(levels(provider, "kimi-k2.7-code")).toEqual([]);
      expect(levels(provider, "kimi-k2.6")).toEqual(["none", "enabled"]);
    }
    for (const provider of ["zai", "zhipuai"]) {
      expect(levels(provider, "glm-5.3-flashx")).toEqual(["low", "high", "max"]);
      expect(levels(provider, "glm-5.2")).toEqual(["none", "high", "max"]);
      expect(levels(provider, "glm-5v-turbo")).toEqual(["none", "enabled"]);
      expect(levels(provider, "glm-5-turbo")).toEqual(["none", "enabled"]);
    }
    expect(levels("minimax", "MiniMax-M3.1-Flash")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(levels("minimax-coding-plan", "MiniMax-M3")).toEqual(["none"]);
    expect(levels("minimax", "MiniMax-M2.7")).toEqual([]);
    expect(levels("alibaba", "qwen3.8-max")).toEqual(["none", "low", "medium", "xhigh"]);
    expect(modelControls("alibaba", "qwen3.8-max").budget).toBe(true);
    expect(levels("alibaba-cn", "kimi-k3")).toEqual(["low", "high", "max"]);
    expect(levels("alibaba-cn", "kimi/kimi-k2.5")).toEqual([]);
    expect(levels("alibaba-cn", "kimi-k2-thinking")).toEqual([]);
    expect(levels("alibaba-cn", "glm-5.2")).toEqual(["none", "high", "max"]);
    expect(levels("alibaba-token-plan", "deepseek-v4-pro-0813")).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
    expect(levels("alibaba-cn", "MiniMax-M2.5")).toEqual([]);
    expect(levels("openai", "gpt-6.1-terra")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelControls("openai", "gpt-6.1-terra").verbosity).toBe(true);
    expect(levels("openai", "gpt-5.5-pro")).toEqual(["medium", "high", "xhigh"]);
    expect(levels("openai", "gpt-5.3-codex")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(levels("openai-compatible", "gpt-5.6-sol")).toEqual(["none"]);
    expect(levels("openai-compatible", "gpt-6.1-terra")).toEqual([]);
    expect(levels("xai", "grok-4.3")).toEqual(["none", "low", "medium", "high"]);
    expect(levels("xai", "grok-4.20-0309-reasoning")).toEqual([]);
    expect(levels("mistral", "mistral-large-4")).toEqual(["low", "medium", "high"]);
    expect(levels("mistral", "mistral-medium-latest")).toEqual(["none", "high"]);
    expect(levels("mistral", "zai-glm-5-3-flash")).toEqual([]);
    expect(levels("groq", "qwen/qwen3.6-27b")).toEqual(["none"]);
    expect(levels("cerebras", "qwen-3.8-27b")).toEqual(["none", "low", "medium", "high"]);
    expect(levels("google", "gemini-4-argon")).toEqual(["low", "medium", "high"]);
    expect(levels("google", "gemini-3.7-flash")).toEqual(["low", "medium", "high"]);
    expect(levels("anthropic", "claude-haiku-5-5")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(levels("anthropic", "claude-opus-5-5")).not.toContain("none");
    expect(levels("anthropic", "claude-fable-5-1")).not.toContain("none");
    expect(levels("claude-code", "claude-opus-4-8")).not.toContain("none");
    expect(levels("togetherai", "moonshotai/Kimi-K3")).toEqual(["none", "low", "high", "max"]);
    expect(levels("togetherai", "zai-org/GLM-5.3")).toEqual(["low", "medium", "high", "max"]);
    expect(levels("fireworks-ai", "accounts/fireworks/models/minimax-m3p1-flash")).toContain("max");
    expect(levels("deepinfra", "zai-org/GLM-5.3")).toEqual(["low", "high", "max"]);
    expect(levels("siliconflow-cn", "deepseek-ai/DeepSeek-V4-Pro")).toEqual(["high", "max"]);
    expect(levels("volcengine", "glm-5-3-flash-260828")).toEqual(["low", "high", "max"]);
    expect(levels("volcengine", "doubao-seed-1-8-251228")).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(levels("openrouter", "moonshotai/kimi-k3.1-pro")).toEqual(["low", "high", "max"]);
    expect(levels("openrouter", "z-ai/glm-5.3")).toEqual(["low", "high", "max"]);
    expect(levels("openrouter", "x-ai/grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(levels("openrouter", "anthropic/claude-haiku-5.5")).not.toContain("none");
    expect(levels("openrouter", "anthropic/claude-sonnet-4.5")).toEqual([]);
    expect(modelControls("openrouter", "anthropic/claude-sonnet-4.5").budget).toBe(true);
  });
  it("reads an On saved before a model offered levels as its default thinking", () => {
    for (const [provider, model] of [
      ["togetherai", "moonshotai/Kimi-K3"],
      ["zai", "glm-5.2"],
      ["alibaba", "qwen3.8-max"],
    ] as const) {
      expect(modelOptionsProblem(provider, model, { reasoningEffort: "enabled" })).toBeUndefined();
      expect(modelProviderOptions(provider, model, { reasoningEffort: "enabled" })).toEqual({});
    }
    // Where On still means turning thinking on, it is sent as before.
    expect(modelProviderOptions("alibaba", "qwen-plus", { reasoningEffort: "enabled" })).toEqual({
      enable_thinking: true,
    });
    expect(modelOptionsProblem("zai", "glm-5.3", { reasoningEffort: "none" })).toBeTruthy();
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
