import { type KeydRecord, TaskPricing } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { describe, expect, it } from "vitest";
import { bindingOf, pricingOf, resolveRole } from "./bindings.ts";

const at = "2026-10-03T00:00:00Z";
const key = (id: string, provider: KeydRecord["provider"], baseURL?: string): KeydRecord => ({
  id,
  kind: "llm",
  provider,
  createdAt: at,
  updatedAt: at,
  ...(baseURL ? { baseURL } : {}),
});
const catalog = () => normalizeCatalog(MODELS_DEV_FIXTURE, at);
const surrogate = "ld_llm_0123456789abcdefghijkl_abcdef";

describe("role binding and immutable task pricing boundaries", () => {
  it("requires compatible keys to match the provider endpoint even when metadata omits it", () => {
    const choice = {
      provider: "togetherai",
      model: "custom",
      key: "gateway",
    };
    const data = normalizeCatalog(
      {
        togetherai: {
          models: { custom: { id: "custom", tool_call: true, cost: { input: 1, output: 2 } } },
        },
      },
      at,
    );
    for (const base of [
      undefined,
      "https://wrong.example/v1",
      "https://api.together.xyz/v1?different=1",
    ])
      expect(() =>
        resolveRole("main", choice, data, [key("gateway", "openai-compatible", base)]),
      ).toThrow(/bound to/);
  });
  it("permits either explicit zero price side but rejects zero pairs, incomplete pairs and unsupported catalog prices", () => {
    const keys = [key("gateway", "openai-compatible", "https://example.test/v1")];
    for (const price of [
      { inputUSDPerMTok: 0, outputUSDPerMTok: 2 },
      { inputUSDPerMTok: 1, outputUSDPerMTok: 0 },
    ])
      expect(
        resolveRole(
          "main",
          { provider: "openai-compatible", model: "custom", key: "gateway", price },
          undefined,
          keys,
        ).model,
      ).toMatchObject(price);
    for (const price of [
      { inputUSDPerMTok: 0, outputUSDPerMTok: 0 },
      { inputUSDPerMTok: 1 },
      { inputUSDPerMTok: Infinity, outputUSDPerMTok: 1 },
    ])
      expect(() =>
        resolveRole(
          "main",
          { provider: "openai-compatible", model: "custom", key: "gateway", price } as never,
          undefined,
          keys,
        ),
      ).toThrow(/selection or price/);
    const bad = catalog();
    const model = bad.providers.anthropic?.models["claude-sonnet-5-5"];
    if (!model) throw new Error("fixture missing");
    model.inputUSDPerMTok = 10_001;
    expect(() =>
      resolveRole("main", { provider: "anthropic", model: model.id, key: "claude" }, bad, [
        key("claude", "anthropic"),
      ]),
    ).toThrow(/unsupported/);
  });
  it("rejects price overrides of priced catalog entries and preserves local no-key routes", () => {
    expect(() =>
      resolveRole(
        "main",
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          key: "claude",
          price: { inputUSDPerMTok: 1, outputUSDPerMTok: 1 },
        },
        catalog(),
        [key("claude", "anthropic")],
      ),
    ).toThrow(/already priced/);
    expect(() =>
      resolveRole("local", { provider: "ollama", model: "local", key: "gateway" }, undefined, []),
    ).toThrow(/no stored key/);
    const local = resolveRole("local", { provider: "ollama", model: "local" }, undefined, []);
    expect(bindingOf(local, {})).toMatchObject({ route: "ollama", maxOutputTokens: 4096 });
    expect(pricingOf([local]).routes[0]?.models[0]).toMatchObject({
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
    });
  });
  it("allows no-tools models only in fast and rejects inherited or missing surrogates", () => {
    const keys = [key("openai", "openai")],
      choice = { provider: "openai", model: "fixture-text-no-tools", key: "openai" };
    expect(resolveRole("fast", choice, catalog(), keys).capability.tier).toBe("no-tools");
    expect(() => resolveRole("main", choice, catalog(), keys)).toThrow(/cannot call tools/);
    const main = resolveRole(
      "main",
      { provider: "anthropic", model: "claude-sonnet-5-5", key: "constructor" },
      catalog(),
      [key("constructor", "anthropic")],
    );
    expect(() => bindingOf(main, {})).toThrow(/valid surrogate/);
    expect(() => bindingOf(main, Object.create({ constructor: surrogate }))).toThrow(
      /valid surrogate/,
    );
    expect(bindingOf(main, { constructor: surrogate }).surrogate).toBe(surrogate);
  });
  it("snapshots actual routes and capped prices without mutating catalog or being changed by future settings", () => {
    const data = catalog();
    const keys = [key("claude-personal", "anthropic")];
    const main = resolveRole(
      "main",
      { provider: "anthropic", model: "claude-sonnet-5-5", key: "claude-personal" },
      data,
      keys,
    );
    const fast = { ...main, role: "fast" as const };
    const pricing = pricingOf([main, fast]);
    expect(TaskPricing.safeParse(pricing).success).toBe(true);
    expect(pricing.routes).toHaveLength(1);
    expect(pricing.routes[0]?.route).toBe("claude-personal");
    expect(pricing.routes[0]?.models).toHaveLength(1);
    expect(pricing.routes[0]?.models[0]).toMatchObject({
      maxOutputTokens: 16_000,
      inputUSDPerMTok: 2,
      outputUSDPerMTok: 10,
      cacheReadUSDPerMTok: 0.2,
    });
    const mutable = data.providers.anthropic?.models[main.model.id];
    if (!mutable) throw new Error("fixture missing");
    mutable.inputUSDPerMTok = 100;
    expect(main.model.inputUSDPerMTok).toBe(2);
    expect(pricing.routes[0]?.models[0]?.inputUSDPerMTok).toBe(2);
    expect(Object.isFrozen(pricing.routes[0]?.models[0])).toBe(true);
    expect(() =>
      pricingOf([main, { ...fast, model: { ...fast.model, inputUSDPerMTok: 3 } }]),
    ).toThrow(/conflicting prices/);
  });
});
