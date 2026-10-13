import type { KeydRecord } from "@localdot/protocol";
import { keydRouteModel, normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { describe, expect, it } from "vitest";
import { BindingError, bindingOf, planOnly, pricingOf, resolveRole } from "./bindings.ts";

const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-02T00:00:00.000Z");
const at = "2026-10-02T00:00:00Z";
const keys: KeydRecord[] = [
  { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: at, updatedAt: at },
  { id: "deepseek", kind: "llm", provider: "deepseek", createdAt: at, updatedAt: at },
  {
    id: "deepseek-compat",
    kind: "llm",
    provider: "openai-compatible",
    baseURL: "https://api.deepseek.com/v1",
    createdAt: at,
    updatedAt: at,
  },
  {
    id: "other",
    kind: "llm",
    provider: "openai-compatible",
    baseURL: "https://evil.example/v1",
    createdAt: at,
    updatedAt: at,
  },
  {
    id: "web",
    kind: "http",
    hosts: ["api.example.com"],
    header: "authorization",
    format: "bearer",
    createdAt: at,
    updatedAt: at,
  },
];
const SURROGATE = "ld_llm_0123456789abcdefghijkl_abcdef";

describe("resolveRole", () => {
  it("snapshots options into the brain binding and rejects unsupported settings", () => {
    const choice = {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      key: "anthropic",
      options: { reasoningEffort: "high" as const },
    };
    const role = resolveRole("main", choice, catalog, keys);
    expect(bindingOf(role, { anthropic: SURROGATE }).options).toEqual({ reasoningEffort: "high" });
    expect(Object.isFrozen(role.options)).toBe(true);
    expect(() =>
      resolveRole("main", { ...choice, options: { reasoningEffort: "none" } }, catalog, keys),
    ).toThrow(/does not support/);
  });
  it("binds Claude Sonnet 5.5 through the user's anthropic key with the native toolset", () => {
    const r = resolveRole(
      "main",
      { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      catalog,
      keys,
    );
    expect(bindingOf(r, { anthropic: SURROGATE })).toEqual({
      provider: "anthropic",
      route: "anthropic",
      client: "anthropic",
      model: "claude-sonnet-5-5",
      surrogate: SURROGATE,
      computer: "anthropic-toolset",
      coords: "pixels",
      vision: true,
      reasoning: true,
      contextTokens: 1_000_000,
      maxOutputTokens: 16_000,
    });
  });

  it("binds a local model through keyd's built-in route without a key", () => {
    const r = resolveRole(
      "local",
      { provider: "lmstudio", model: "qwen/qwen3.8-27b" },
      catalog,
      [],
    );
    expect(bindingOf(r, {})).toMatchObject({
      route: "lmstudio",
      client: "lmstudio",
      computer: "generic",
      coords: "per1000",
    });
    expect(bindingOf(r, {}).surrogate).toBeUndefined();
    const unknown = resolveRole(
      "local",
      { provider: "ollama", model: "qwen3.8:27b" },
      undefined,
      [],
    );
    expect(unknown.model.inputUSDPerMTok).toBe(0);
  });

  it("refuses a missing key, a key of another kind, and a key bound to another base URL", () => {
    expect(() =>
      resolveRole("main", { provider: "anthropic", model: "claude-sonnet-5-5" }, catalog, keys),
    ).toThrow(/needs a key/);
    expect(() =>
      resolveRole(
        "main",
        { provider: "anthropic", model: "claude-sonnet-5-5", key: "web" },
        catalog,
        keys,
      ),
    ).toThrow(/not a Anthropic key|not an? Anthropic key/);
    expect(() =>
      resolveRole("main", { provider: "togetherai", model: "m", key: "other" }, catalog, keys),
    ).toThrow(/bound to https:\/\/evil/);
    // DeepSeek is first-class (P5a-R31): an OpenAI-compatible key, even at DeepSeek's address, is
    // not a DeepSeek key, so the model never runs on a route without DeepSeek's preset.
    expect(() =>
      resolveRole(
        "main",
        { provider: "deepseek", model: "deepseek-chat", key: "deepseek-compat" },
        catalog,
        keys,
      ),
    ).toThrow(/not a DeepSeek key/);
    const deepseek = resolveRole(
      "main",
      { provider: "deepseek", model: "deepseek-chat", key: "deepseek" },
      catalog,
      keys,
    );
    expect(deepseek.capability.computer).toBe("none");
    expect(bindingOf(deepseek, { deepseek: SURROGATE })).toMatchObject({
      route: "deepseek",
      client: "deepseek",
      surrogate: SURROGATE,
    });
  });

  it("refuses a key whose value has to be entered again, naming it", () => {
    const stale = keys.map((k) => (k.id === "deepseek" ? { ...k, reenter: true } : k));
    expect(() =>
      resolveRole(
        "main",
        { provider: "deepseek", model: "deepseek-chat", key: "deepseek" },
        catalog,
        stale,
      ),
    ).toThrow(
      new BindingError("main", "key deepseek needs re-entering: enter it again under Keys"),
    );
  });

  it("refuses a key changed outside localDot, naming it, and never as one to enter again", () => {
    const changed = keys.map((k) => (k.id === "deepseek" ? { ...k, rebound: true } : k));
    expect(() =>
      resolveRole(
        "main",
        { provider: "deepseek", model: "deepseek-chat", key: "deepseek" },
        catalog,
        changed,
      ),
    ).toThrow(
      new BindingError(
        "main",
        "key deepseek was changed outside localDot: remove it under Keys and add it again",
      ),
    );
  });

  it("refuses an unknown model, a model without tools as main, and M8 providers", () => {
    expect(() =>
      resolveRole(
        "main",
        { provider: "anthropic", model: "claude-9", key: "anthropic" },
        catalog,
        keys,
      ),
    ).toThrow(BindingError);
    expect(() =>
      resolveRole(
        "main",
        { provider: "openai", model: "text-embedding-4", key: "anthropic" },
        catalog,
        keys,
      ),
    ).toThrow(BindingError);
    expect(() =>
      resolveRole("main", { provider: "amazon-bedrock", model: "x" }, catalog, keys),
    ).toThrow(/M8/);
  });

  it("runs no unpriced model on a paid route, and no OpenRouter router (P5a-R32)", () => {
    const more: KeydRecord[] = [
      ...keys,
      { id: "openrouter", kind: "llm", provider: "openrouter", createdAt: at, updatedAt: at },
      {
        id: "gateway",
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://llm.example.test/v1",
        createdAt: at,
        updatedAt: at,
      },
    ];
    const free = "meta-llama/llama-4-maverick:free";
    const price = { inputUSDPerMTok: 0.2, outputUSDPerMTok: 0.6 };
    expect(() =>
      resolveRole(
        "main",
        { provider: "openrouter", model: "openrouter/auto", key: "openrouter", price },
        catalog,
        more,
      ),
    ).toThrow(/picks a model at that model's price/);
    expect(() =>
      resolveRole(
        "main",
        { provider: "openrouter", model: free, key: "openrouter" },
        catalog,
        more,
      ),
    ).toThrow(/no price in the catalog/);
    const priced = resolveRole(
      "main",
      { provider: "openrouter", model: free, key: "openrouter", price },
      catalog,
      more,
    );
    expect(keydRouteModel(priced.model)).toMatchObject({
      id: free,
      inputUSDPerMTok: 0.2,
      outputUSDPerMTok: 0.6,
    });
    // The Other provider's models are never in the catalog: the user names their price.
    expect(() =>
      resolveRole(
        "main",
        { provider: "openai-compatible", model: "glm-5", key: "gateway" },
        catalog,
        more,
      ),
    ).toThrow(/no price in the catalog/);
    expect(
      resolveRole(
        "main",
        { provider: "openai-compatible", model: "glm-5", key: "gateway", price },
        catalog,
        more,
      ).model.outputUSDPerMTok,
    ).toBe(0.6);
    // A local server's model is free and runs on keyd's local route, where nothing is billed.
    expect(
      resolveRole("local", { provider: "ollama", model: "qwen3.8:27b" }, catalog, []).model
        .inputUSDPerMTok,
    ).toBe(0);
  });
});

describe("vendor presets and plans", () => {
  const bound = (id: string, baseURL: string): KeydRecord => ({
    id,
    kind: "llm",
    provider: "openai-compatible",
    baseURL,
    createdAt: at,
    updatedAt: at,
  });
  const vendorKeys = [
    bound("zai", "https://api.z.ai/api/paas/v4/"),
    bound("zai-plan", "https://api.z.ai/api/coding/paas/v4"),
    bound("minimax", "https://api.minimax.io/v1"),
  ];
  const GLM_PLAN =
    "Z.ai lets this plan run only in the coding tools it lists. Use a Z.ai API key here instead.";

  it("binds a Z.ai key to the pinned address, with GLM vision on the 0–1000 grid", () => {
    const r = resolveRole(
      "main",
      { provider: "zai", model: "glm-5v-turbo", key: "zai" },
      catalog,
      vendorKeys,
    );
    expect(bindingOf(r, { zai: SURROGATE })).toMatchObject({
      route: "zai",
      client: "openai-compatible",
      model: "glm-5v-turbo",
      computer: "generic",
      coords: "per1000",
      vision: true,
    });
    expect(r.model).toMatchObject({ inputUSDPerMTok: 1.2, outputUSDPerMTok: 4 });
  });

  it("refuses a key bound to another address, even the same vendor's plan endpoint", () => {
    expect(() =>
      resolveRole(
        "main",
        { provider: "zai", model: "glm-5v-turbo", key: "zai-plan" },
        catalog,
        vendorKeys,
      ),
    ).toThrow(/zai-plan is bound to https:\/\/api\.z\.ai\/api\/coding\/paas\/v4, not/);
  });

  it("refuses a plan the vendor keeps to its listed tools, with its one-sentence reason", () => {
    const price = { inputUSDPerMTok: 1, outputUSDPerMTok: 1 };
    for (const key of ["zai-plan", "zai", undefined])
      expect(() =>
        resolveRole(
          "main",
          { provider: "zai-coding-plan", model: "glm-5.3-flash", price, ...(key ? { key } : {}) },
          catalog,
          vendorKeys,
        ),
      ).toThrow(new BindingError("main", GLM_PLAN));
    expect(() =>
      resolveRole(
        "fast",
        { provider: "kimi-code-plan-global", model: "kimi-for-coding" },
        catalog,
        vendorKeys,
      ),
    ).toThrow(/Use a Moonshot API key here instead\.$/);
  });

  it("prices a plan at zero on a flat route, with no manual price", () => {
    const choice = { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "minimax" };
    const plan = resolveRole("main", choice, catalog, vendorKeys);
    expect(plan.flat).toBe(true);
    expect(keydRouteModel(plan.model)).toEqual({
      id: "MiniMax-M3",
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
      maxOutputTokens: 512_000,
    });
    expect(bindingOf(plan, { minimax: SURROGATE })).toMatchObject({
      route: "minimax",
      client: "openai-compatible",
      vision: true,
    });
    expect(pricingOf([plan])).toEqual({
      v: 1,
      routes: [
        {
          route: "minimax",
          flat: true,
          models: [
            { id: "MiniMax-M3", inputUSDPerMTok: 0, outputUSDPerMTok: 0, maxOutputTokens: 16_000 },
          ],
        },
      ],
    });
    expect(planOnly([plan])).toBe(true);
    expect(() =>
      resolveRole(
        "main",
        { ...choice, price: { inputUSDPerMTok: 0.3, outputUSDPerMTok: 1.2 } },
        catalog,
        vendorKeys,
      ),
    ).toThrow(
      new BindingError(
        "main",
        "MiniMax Token Plan takes no manual price; choose its model again in Settings",
      ),
    );
  });

  it("keeps a plan flat even if the catalog starts to price its models", () => {
    const priced = structuredClone(catalog);
    const model = priced.providers["minimax-coding-plan"]?.models["MiniMax-M3"];
    if (!model) throw new Error("fixture plan model missing");
    Object.assign(model, { inputUSDPerMTok: 2, outputUSDPerMTok: 8, cacheReadUSDPerMTok: 1 });
    const plan = resolveRole(
      "main",
      { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "minimax" },
      priced,
      vendorKeys,
    );
    expect(pricingOf([plan]).routes[0]?.models[0]).toEqual({
      id: "MiniMax-M3",
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
      maxOutputTokens: 16_000,
    });
  });

  it("keeps the dollar budget for a paid fast role beside a plan main", () => {
    const main = resolveRole(
      "main",
      { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "minimax" },
      catalog,
      vendorKeys,
    );
    const fast = resolveRole(
      "fast",
      { provider: "zai", model: "glm-5v-turbo", key: "zai" },
      catalog,
      vendorKeys,
    );
    expect(fast.flat).toBeUndefined();
    expect(pricingOf([main, fast]).routes).toEqual([
      expect.objectContaining({ route: "minimax", flat: true }),
      {
        route: "zai",
        models: [expect.objectContaining({ inputUSDPerMTok: 1.2, outputUSDPerMTok: 4 })],
      },
    ]);
    expect(planOnly([main, fast])).toBe(false);
    expect(planOnly([fast])).toBe(false);
    const local = resolveRole("local", { provider: "ollama", model: "qwen3.8:27b" }, catalog, []);
    expect(planOnly([main, local])).toBe(true);
    expect(planOnly([local])).toBe(false);
  });

  it("never marks a paid provider flat, and refuses a forged flat field", () => {
    expect(() =>
      resolveRole(
        "main",
        { provider: "zai", model: "glm-5v-turbo", key: "zai", flat: true } as never,
        catalog,
        vendorKeys,
      ),
    ).toThrow(new BindingError("main", "invalid model selection or price"));
    const paid = resolveRole(
      "main",
      { provider: "minimax", model: "MiniMax-M3", key: "minimax" },
      catalog,
      vendorKeys,
    );
    expect(paid.flat).toBeUndefined();
    expect(pricingOf([paid]).routes[0]).not.toHaveProperty("flat");
    expect(pricingOf([paid]).routes[0]?.models[0]).toMatchObject({
      inputUSDPerMTok: 0.3,
      outputUSDPerMTok: 1.2,
    });
    expect(planOnly([paid])).toBe(false);
  });

  it("refuses one key used both as a plan and as a paid key in one task", () => {
    const plan = resolveRole(
      "main",
      { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "minimax" },
      catalog,
      vendorKeys,
    );
    const paid = resolveRole(
      "fast",
      { provider: "minimax", model: "MiniMax-M3", key: "minimax" },
      catalog,
      vendorKeys,
    );
    expect(() => pricingOf([plan, paid])).toThrow(
      new BindingError("fast", "key minimax is a plan for one model and pay as you go for another"),
    );
  });
});

describe("custom endpoints state what their model can do", () => {
  const custom: KeydRecord[] = [
    {
      id: "anc",
      kind: "llm",
      provider: "anthropic-compatible",
      baseURL: "https://api.z.ai/api/anthropic/v1",
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "gateway",
      kind: "llm",
      provider: "openai-compatible",
      baseURL: "https://llm.example.test/v1",
      createdAt: at,
      updatedAt: at,
    },
    ...keys,
  ];
  const price = { inputUSDPerMTok: 0.6, outputUSDPerMTok: 2.2 };
  const anc = { provider: "anthropic-compatible", model: "glm-5.3-flash", key: "anc", price };

  it("reaches an Anthropic-compatible endpoint with localDot's computer tool by default", () => {
    const r = resolveRole("main", anc, catalog, custom);
    expect(bindingOf(r, { anc: SURROGATE })).toEqual({
      provider: "anthropic-compatible",
      route: "anc",
      client: "anthropic-compatible",
      model: "glm-5.3-flash",
      surrogate: SURROGATE,
      computer: "generic",
      coords: "per1000",
      vision: true,
      reasoning: false,
      contextTokens: 32_768,
      maxOutputTokens: 4_096,
    });
    expect(() => resolveRole("main", { ...anc, key: "gateway" }, catalog, custom)).toThrow(
      new BindingError("main", "key gateway is not a Other (Anthropic-compatible) key"),
    );
    expect(() => resolveRole("main", { ...anc, price: undefined }, catalog, custom)).toThrow(
      /no price in the catalog/,
    );
  });

  it("uses Responses with an existing compatible key without changing its endpoint or pricing", () => {
    const choice = {
      provider: "openai-responses-compatible",
      model: "gateway-model",
      key: "gateway",
      price,
    };
    const resolved = resolveRole("main", choice, undefined, custom);
    expect(bindingOf(resolved, { gateway: SURROGATE })).toMatchObject({
      client: "openai",
      route: "gateway",
      model: "gateway-model",
      surrogate: SURROGATE,
      computer: "generic",
      vision: true,
    });
    const chat = resolveRole(
      "main",
      { ...choice, provider: "openai-compatible" },
      undefined,
      custom,
    );
    expect(chat.client).toBe("openai-compatible");
    expect(pricingOf([resolved])).toEqual(pricingOf([chat]));
    expect(() => resolveRole("main", { ...choice, key: "anc" }, undefined, custom)).toThrow(
      /is not a/,
    );
  });

  it("gives a model that cannot see images the text-only capability", () => {
    for (const choice of [
      { ...anc, vision: false },
      {
        provider: "openai-compatible",
        model: "kimi-k2.7-code",
        key: "gateway",
        price,
        vision: false,
      },
    ]) {
      const r = resolveRole("main", choice, catalog, custom);
      expect(r.capability.tier).toBe("text-only");
      expect(bindingOf(r, { anc: SURROGATE, gateway: SURROGATE })).toMatchObject({
        computer: "none",
        vision: false,
      });
    }
  });

  it("honours the context window the user states", () => {
    const r = resolveRole("main", { ...anc, contextTokens: 200_000 }, catalog, custom);
    expect(bindingOf(r, { anc: SURROGATE }).contextTokens).toBe(200_000);
    const o = resolveRole(
      "fast",
      { provider: "openai-compatible", model: "m", key: "gateway", price, contextTokens: 4_096 },
      catalog,
      custom,
    );
    expect(bindingOf(o, { gateway: SURROGATE }).contextTokens).toBe(4_096);
  });

  it("runs a custom endpoint on a flat-rate plan at zero, on a flat route, with no price", () => {
    const { price: _, ...unpriced } = anc;
    const plan = resolveRole("main", { ...unpriced, plan: true }, catalog, custom);
    expect(plan.flat).toBe(true);
    expect(pricingOf([plan])).toEqual({
      v: 1,
      routes: [
        {
          route: "anc",
          flat: true,
          models: [
            {
              id: "glm-5.3-flash",
              inputUSDPerMTok: 0,
              outputUSDPerMTok: 0,
              maxOutputTokens: 4_096,
            },
          ],
        },
      ],
    });
    expect(planOnly([plan])).toBe(true);
    expect(() => resolveRole("main", { ...anc, plan: true }, catalog, custom)).toThrow(
      new BindingError("main", "a flat-rate plan takes no manual price"),
    );
    const paid = resolveRole("fast", anc, catalog, custom);
    expect(paid.flat).toBeUndefined();
    expect(() => pricingOf([plan, paid])).toThrow(/key anc is a plan for one model/);
  });

  it("refuses stated abilities and plans for every provider whose models come from elsewhere", () => {
    const zai: KeydRecord = {
      id: "zai",
      kind: "llm",
      provider: "openai-compatible",
      baseURL: "https://api.z.ai/api/paas/v4",
      createdAt: at,
      updatedAt: at,
    };
    const minimax: KeydRecord = { ...zai, id: "minimax", baseURL: "https://api.minimax.io/v1" };
    for (const choice of [
      { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      { provider: "zai", model: "glm-5v-turbo", key: "zai" },
      { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "minimax" },
      { provider: "ollama", model: "qwen3.8:27b" },
    ])
      for (const stated of [
        { vision: false },
        { vision: true },
        { contextTokens: 100_000 },
        { plan: true },
      ])
        expect(
          () =>
            resolveRole(
              choice.provider === "ollama" ? "local" : "main",
              { ...choice, ...stated } as never,
              catalog,
              [...custom, zai, minimax],
            ),
          `${choice.provider} ${JSON.stringify(stated)}`,
        ).toThrow(
          new BindingError(
            choice.provider === "ollama" ? "local" : "main",
            "only a custom endpoint states what its model can do or a flat-rate plan",
          ),
        );
  });
});
