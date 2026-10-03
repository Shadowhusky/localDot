import { describe, expect, it } from "vitest";
import { capabilityOf, usableAs } from "./capabilities.ts";
import { Catalog, findModel, keydRouteModel, localModel, normalizeCatalog } from "./catalog.ts";
import { FIRST_CLASS_BEARER, PROVIDERS, providerById } from "./registry.ts";
import { MODELS_DEV_FIXTURE } from "./testing/models-dev-fixture.ts";

const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-02T00:00:00.000Z");
const cap = (provider: string, model: string) => {
  const p = providerById(provider);
  const m = findModel(catalog, provider, model);
  if (!p || !m) throw new Error(`${provider}/${model} missing`);
  return capabilityOf(p, m);
};

describe("normalizeCatalog", () => {
  it("keeps the fields the picker and keyd need, in localDot's fixed schema", () => {
    expect(Catalog.parse(catalog)).toEqual(catalog);
    expect(findModel(catalog, "anthropic", "claude-sonnet-5-5")).toEqual({
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      vision: true,
      toolCall: true,
      reasoning: true,
      contextTokens: 1_000_000,
      maxOutputTokens: 64_000,
      inputUSDPerMTok: 2,
      outputUSDPerMTok: 10,
      cacheReadUSDPerMTok: 0.2,
      cacheWriteUSDPerMTok: 2.5,
      releaseDate: "2026-09-28",
    });
  });

  it("skips a malformed provider or model instead of failing the whole catalog", () => {
    expect(catalog.skipped).toBe(3);
    expect(catalog.providers["broken provider!"]).toBeUndefined();
    expect(Object.keys(catalog.providers.mistral?.models ?? {})).toEqual(["mistral-medium-3"]);
    expect(() => normalizeCatalog([], "x")).toThrow(TypeError);
  });

  it("gives a model with no output limit a default, so keyd can bound it", () => {
    expect(findModel(catalog, "openai", "fixture-text-no-tools")?.maxOutputTokens).toBe(4096);
  });
});

describe("capabilityOf", () => {
  it("marks Claude 5.x native with the toolset and Haiku 4.5 with the older tool", () => {
    expect(cap("anthropic", "claude-sonnet-5-5")).toMatchObject({
      tier: "native",
      computer: "anthropic-toolset",
      coords: "pixels",
    });
    expect(cap("anthropic", "claude-opus-5-5")).toMatchObject({ computer: "anthropic-toolset" });
    expect(cap("anthropic", "claude-haiku-4-5-20251001")).toMatchObject({
      tier: "native",
      computer: "anthropic-legacy",
    });
  });

  it("gives Gemini and Qwen the generic tool on the 0–1000 grid, others screenshot pixels", () => {
    expect(cap("google", "gemini-3.1-flash-lite")).toMatchObject({
      tier: "vision-tools",
      computer: "generic",
      coords: "per1000",
    });
    expect(cap("lmstudio", "qwen/qwen3.8-27b")).toMatchObject({
      computer: "generic",
      coords: "per1000",
    });
    expect(cap("openai", "gpt-6.1-sol")).toMatchObject({ computer: "generic", coords: "pixels" });
    expect(cap("mistral", "mistral-medium-3")).toMatchObject({
      computer: "generic",
      coords: "pixels",
    });
  });

  it("says when a model can't see the screen or can't call tools", () => {
    const text = cap("deepseek", "deepseek-chat");
    expect(text).toMatchObject({ tier: "text-only", computer: "none" });
    expect(text.note).toMatch(/not the screen/);
    const none = cap("openai", "fixture-text-no-tools");
    expect(none.tier).toBe("no-tools");
    expect(usableAs("main", none)).toBe(false);
    expect(usableAs("fast", none)).toBe(true);
    expect(usableAs("main", text)).toBe(true);
  });
});

describe("the first-class providers", () => {
  it("give xAI, Mistral, DeepSeek, Groq and OpenRouter their own client and keyd kind, the rest the OpenAI-compatible one", () => {
    expect(FIRST_CLASS_BEARER).toEqual(["xai", "mistral", "deepseek", "groq", "openrouter"]);
    for (const id of FIRST_CLASS_BEARER) {
      // keyd fixes their base URLs (P5a-R31): the registry names none for the key to match.
      expect(providerById(id)).toEqual({ id, name: expect.any(String), client: id, keyd: id });
    }
    const compatible = PROVIDERS.filter((p) => p.client === "openai-compatible" && !p.availableIn);
    expect(compatible.map((p) => p.id)).toEqual([
      "togetherai",
      "fireworks-ai",
      "cerebras",
      "perplexity",
      "cohere",
      "deepinfra",
      "moonshotai",
      "alibaba",
      "openai-compatible",
    ]);
    for (const p of compatible.slice(0, 8)) {
      expect(p.keyd).toBe("openai-compatible");
      expect(p.baseURL).toMatch(/^https:\/\/[a-z0-9.-]+(\/|$)/);
    }
  });

  it("map their catalog models: the generic tool, Gemini on the grid wherever it is served, and text-only models", () => {
    expect(cap("xai", "grok-4.3")).toMatchObject({
      tier: "vision-tools",
      computer: "generic",
      coords: "pixels",
    });
    expect(cap("groq", "meta-llama/llama-4-scout-17b-16e-instruct")).toMatchObject({
      computer: "generic",
      coords: "pixels",
    });
    expect(cap("groq", "openai/gpt-oss-120b")).toMatchObject({ tier: "text-only" });
    expect(cap("openrouter", "google/gemini-3.6-flash")).toMatchObject({
      computer: "generic",
      coords: "per1000",
    });
    // Anthropic's toolset needs Anthropic's own API; through OpenRouter Claude gets the generic tool.
    expect(cap("openrouter", "anthropic/claude-sonnet-5.5")).toMatchObject({
      tier: "vision-tools",
      computer: "generic",
      coords: "pixels",
    });
    // keyd's model ids (Part 4a's settings): OpenRouter's vendor/model form is one.
    const m = findModel(catalog, "openrouter", "google/gemini-3.6-flash");
    if (!m) throw new Error("missing");
    expect(keydRouteModel(m).id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/);
  });
});

describe("keydRouteModel", () => {
  it("writes keyd's route-model shape with the maximum output keyd requires", () => {
    const m = findModel(catalog, "google", "gemini-3.1-flash-lite");
    if (!m) throw new Error("missing");
    expect(keydRouteModel(m)).toEqual({
      id: "gemini-3.1-flash-lite",
      inputUSDPerMTok: 0.25,
      outputUSDPerMTok: 1.5,
      maxOutputTokens: 65_536,
    });
    expect(() => keydRouteModel({ ...m, inputUSDPerMTok: 50_000 })).toThrow(RangeError);
    expect(keydRouteModel(localModel("qwen/qwen3.8-27b"))).toEqual({
      id: "qwen/qwen3.8-27b",
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
      maxOutputTokens: 4096,
    });
  });
});

describe("untrusted catalog names and budget limits", () => {
  it("does not resolve inherited properties as providers or models", () => {
    expect(findModel(catalog, "constructor", "x")).toBeUndefined();
    expect(findModel(catalog, "anthropic", "constructor")).toBeUndefined();
    expect(findModel(catalog, "anthropic", "__proto__")).toBeUndefined();
    const raw = JSON.parse(
      '{"custom":{"models":{"__proto__":{"id":"safe-model","tool_call":true},"constructor":{"id":"other-model","tool_call":true}}}}',
    );
    const normalized = normalizeCatalog(raw, "2026-10-03T00:00:00.000Z");
    expect(Object.getPrototypeOf(normalized.providers.custom?.models)).toBeNull();
    // Zod drops the reserved __proto__ key while parsing the external record.
    expect(findModel(normalized, "custom", "safe-model")).toBeUndefined();
    expect(findModel(normalized, "custom", "constructor")?.id).toBe("other-model");
    expect(Catalog.parse(normalized)).toMatchObject({ skipped: 0 });
  });

  it("refuses prices and limits it cannot represent without underbilling", () => {
    const base = localModel("fixture-model");
    for (const field of [
      "inputUSDPerMTok",
      "outputUSDPerMTok",
      "cacheReadUSDPerMTok",
      "cacheWriteUSDPerMTok",
    ] as const) {
      for (const value of [-1, 10000.01, Number.NaN, Number.POSITIVE_INFINITY])
        expect(() => keydRouteModel({ ...base, [field]: value }), `${field}: ${value}`).toThrow(
          RangeError,
        );
      expect(keydRouteModel({ ...base, [field]: 10000 })[field]).toBe(10000);
    }
    for (const maxOutputTokens of [0, 1.5, 100_000_001, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => keydRouteModel({ ...base, maxOutputTokens })).toThrow(RangeError);
    expect(keydRouteModel({ ...base, maxOutputTokens: 100_000_000 }).maxOutputTokens).toBe(
      100_000_000,
    );
  });
});

it("requires a complete price pair and skips keyd-invalid model IDs", () => {
  const models = {
    missing: { id: "missing" },
    inputOnly: { id: "input-only", cost: { input: 1 } },
    outputOnly: { id: "output-only", cost: { output: 1 } },
    zeroInput: { id: "zero-input", cost: { input: 0, output: 1 } },
    zeroOutput: { id: "zero-output", cost: { input: 1, output: 0 } },
    bad: { id: "bad id", cost: { input: 1, output: 1 } },
  };
  const normalized = normalizeCatalog({ fixture: { models } }, "2026-10-03T00:00:00.000Z");
  for (const id of ["missing", "input-only", "output-only"])
    expect(findModel(normalized, "fixture", id)).toMatchObject({
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
    });
  expect(findModel(normalized, "fixture", "zero-input")).toMatchObject({
    inputUSDPerMTok: 0,
    outputUSDPerMTok: 1,
  });
  expect(findModel(normalized, "fixture", "zero-output")).toMatchObject({
    inputUSDPerMTok: 1,
    outputUSDPerMTok: 0,
  });
  expect(findModel(normalized, "fixture", "bad id")).toBeUndefined();
  expect(normalized.skipped).toBe(1);
});

it("refuses inherited model names after the catalog is saved and reloaded", () => {
  for (const restored of [
    JSON.parse(JSON.stringify(catalog)),
    Catalog.parse(JSON.parse(JSON.stringify(catalog))),
  ]) {
    expect(findModel(restored, "anthropic", "claude-sonnet-5-5")?.id).toBe("claude-sonnet-5-5");
    for (const name of ["constructor", "__proto__", "toString"])
      expect(findModel(restored, "anthropic", name), name).toBeUndefined();
  }
});

it("excludes known non-text generators while preserving unspecified capabilities", () => {
  expect(findModel(catalog, "openai", "text-embedding-4")).toBeUndefined();
  const normalized = normalizeCatalog(
    {
      fixture: {
        models: {
          absent: { id: "absent" },
          empty: { id: "empty", modalities: { output: [] } },
          image: { id: "image", modalities: { output: ["image"] } },
          mixed: { id: "mixed", modalities: { output: ["text", "audio"] } },
        },
      },
    },
    "2026-10-03T00:00:00.000Z",
  );
  expect(Object.keys(normalized.providers.fixture?.models ?? {})).toEqual([
    "absent",
    "empty",
    "mixed",
  ]);
  expect(normalized.skipped).toBe(1);
});
