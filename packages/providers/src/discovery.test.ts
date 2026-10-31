import { describe, expect, it } from "vitest";
import { normalizeCatalog } from "./catalog.ts";
import { applyProviderMetadata, discoveredControls } from "./discovery.ts";
import { modelOptionsProblem, modelProviderOptions } from "./model-options.ts";
import { MODELS_DEV_FIXTURE } from "./testing/models-dev-fixture.ts";

const support = (supported: boolean) => ({ supported });
const capabilities = {
  effort: {
    supported: true,
    low: support(true),
    medium: support(true),
    high: support(true),
    xhigh: support(true),
    max: support(true),
  },
  thinking: { supported: true, types: { adaptive: support(true), enabled: support(false) } },
};
describe("live provider capabilities", () => {
  it("uses provider levels for a future model without a bundled model-name rule", () => {
    const controls = discoveredControls("anthropic", "claude-future", { capabilities });
    expect(controls?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(
      modelOptionsProblem(
        "anthropic",
        "claude-future",
        { reasoningEffort: "max" },
        16000,
        controls,
      ),
    ).toBeUndefined();
    expect(
      modelProviderOptions("anthropic", "claude-future", { reasoningEffort: "max" }, controls),
    ).toEqual({ thinking: { type: "adaptive" }, effort: "max" });
  });
  it("honors explicit removals and accepts null for unavailable extended levels", () => {
    const controls = discoveredControls("anthropic", "claude-opus-5-5", {
      capabilities: {
        ...capabilities,
        effort: { ...capabilities.effort, xhigh: null, max: support(false) },
      },
    });
    expect(controls?.efforts).toEqual(["low", "medium", "high"]);
    expect(
      modelOptionsProblem(
        "anthropic",
        "claude-opus-5-5",
        { reasoningEffort: "max" },
        16000,
        controls,
      ),
    ).toBeTruthy();
  });
  it("never guesses effort enums from a model name list or a reasoning boolean", () => {
    for (const provider of ["openai", "deepseek", "google", "anthropic"])
      expect(
        discoveredControls(provider, "future", { id: "future", reasoning: true }),
      ).toBeUndefined();
    expect(
      discoveredControls("anthropic", "future", { capabilities: { effort: { supported: "yes" } } }),
    ).toBeUndefined();
  });
  it("uses OpenRouter's supported parameters without inventing tiers or unknown effort ranges", () => {
    expect(
      discoveredControls("openrouter", "anthropic/claude-opus-5-5", { supported_parameters: [] })
        ?.efforts,
    ).toEqual([]);
    expect(
      discoveredControls("openrouter", "unknown/future", { supported_parameters: ["reasoning"] })
        ?.efforts,
    ).toEqual([]);
  });
  it("offers Off where the Models API lists thinking disabled beside adaptive", () => {
    const off = {
      ...capabilities,
      thinking: {
        supported: true,
        types: { adaptive: support(true), enabled: support(false), disabled: support(true) },
      },
    };
    const controls = discoveredControls("anthropic", "claude-haiku-5-5", { capabilities: off });
    expect(controls?.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(
      modelProviderOptions("anthropic", "claude-haiku-5-5", { reasoningEffort: "none" }, controls),
    ).toEqual({ thinking: { type: "disabled" } });
  });
  it("narrows OpenRouter's levels to each model's own list and keeps Off from mandatory thinkers", () => {
    const listed = (id: string, reasoning: unknown) =>
      discoveredControls("openrouter", id, { supported_parameters: ["reasoning"], reasoning });
    const flash = listed("google/gemini-3.5-flash", {
      supported_efforts: ["high", "medium", "low", "minimal"],
      default_effort: "medium",
      mandatory: true,
    });
    expect(flash).toMatchObject({
      efforts: ["minimal", "low", "medium", "high"],
      wire: "openrouter",
      budget: false,
    });
    expect(
      listed("moonshotai/kimi-k3.1-pro", { supported_efforts: ["max", "high", "low"] })?.efforts,
    ).toEqual(["none", "low", "high", "max"]);
    // Null takes every gateway level: the family's own where it is known, else the common three.
    expect(listed("z-ai/glm-5.3", { supported_efforts: null, mandatory: true })?.efforts).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(listed("someone/new-model", { supported_efforts: null })?.efforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(listed("moonshotai/kimi-k2.6", { supported_efforts: null })?.efforts).toEqual([
      "none",
      "enabled",
    ]);
    // No effort selection: only a budget, where the model takes one.
    expect(
      listed("anthropic/claude-sonnet-4.5", { supports_max_tokens: true, mandatory: false }),
    ).toMatchObject({ efforts: [], budget: true, wire: "openrouter" });
    expect(
      modelProviderOptions(
        "openrouter",
        "moonshotai/kimi-k3.1-pro",
        { reasoningEffort: "low" },
        listed("moonshotai/kimi-k3.1-pro", { supported_efforts: ["max", "high", "low"] }),
      ),
    ).toEqual({ reasoning: { effort: "low" } });
    // Without the reasoning object, the bundled family rules stay.
    expect(listed("moonshotai/kimi-k3", undefined)?.efforts).toEqual(["low", "high", "max"]);
  });
  it("updates capabilities and limits without trusting API prices, destinations or request keys", () => {
    const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-20T00:00:00.000Z");
    const before = catalog.providers.anthropic?.models["claude-sonnet-5-5"];
    const cost = before?.inputUSDPerMTok;
    applyProviderMetadata(
      catalog,
      "anthropic",
      {
        data: [
          {
            id: "claude-sonnet-5-5",
            capabilities,
            max_tokens: 32768,
            display_name: "Sonnet",
            inputUSDPerMTok: 0,
            url: "https://evil.example",
          },
        ],
      },
      "2026-10-20T00:00:00.000Z",
    );
    expect(catalog.providers.anthropic?.models["claude-sonnet-5-5"]).toMatchObject({
      inputUSDPerMTok: cost,
      maxOutputTokens: 32768,
      name: "Sonnet",
      controls: { efforts: ["low", "medium", "high", "xhigh", "max"] },
    });
    expect(JSON.stringify(catalog)).not.toContain("evil.example");
  });
});
