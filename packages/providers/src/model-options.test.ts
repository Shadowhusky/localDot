import { ModelOptions } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
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
    expect(modelControls("openai", "gpt-6-astra").speeds).toEqual(["standard", "fast"]);
    for (const provider of [
      "deepseek",
      "azure",
      "openai-compatible",
      "openai-responses-compatible",
      "openrouter",
    ])
      expect(modelOptionsProblem(provider, "gpt-6-astra", { speed: "fast" })).toBeTruthy();
    expect(modelOptionsProblem("anthropic", "claude-opus-4-7", { speed: "fast" })).toBeTruthy();
    expect(sameModelOptions({ speed: "standard" }, { speed: "fast" })).toBe(false);
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
      { reasoningEffort: "ultra" },
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
