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
