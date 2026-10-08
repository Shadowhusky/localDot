import type { KeydRecord } from "@localdot/protocol";
import { keydRouteModel, normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { describe, expect, it } from "vitest";
import { BindingError, bindingOf, resolveRole } from "./bindings.ts";

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
  it("binds Claude Sonnet 5.5 through the user's anthropic key with the native toolset", () => {
    const r = resolveRole(
      "main",
      { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      catalog,
      keys,
    );
    expect(bindingOf(r, { anthropic: SURROGATE })).toEqual({
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

  it("still asks for a manual price on a $0 plan model until plan routes are flat-rate", () => {
    const choice = { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "minimax" };
    expect(() => resolveRole("main", choice, catalog, vendorKeys)).toThrow(
      /MiniMax-M3 has no price in the catalog/,
    );
    const priced = resolveRole(
      "main",
      { ...choice, price: { inputUSDPerMTok: 0.3, outputUSDPerMTok: 1.2 } },
      catalog,
      vendorKeys,
    );
    expect(keydRouteModel(priced.model)).toEqual({
      id: "MiniMax-M3",
      inputUSDPerMTok: 0.3,
      outputUSDPerMTok: 1.2,
      maxOutputTokens: 512_000,
    });
    expect(bindingOf(priced, { minimax: SURROGATE })).toMatchObject({
      route: "minimax",
      client: "openai-compatible",
      vision: true,
    });
  });
});
