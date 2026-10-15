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

  it("keeps a separate price for reasoning tokens where the catalog states one", () => {
    const priced = normalizeCatalog(
      {
        google: {
          models: {
            "gemini-flash": {
              id: "gemini-flash",
              cost: { input: 0.3, output: 2.5, reasoning: 3.5 },
            },
          },
        },
      },
      "2026-10-09T00:00:00Z",
    );
    const model = findModel(priced, "google", "gemini-flash");
    expect(model?.reasoningUSDPerMTok).toBe(3.5);
    expect(model && keydRouteModel(model).reasoningUSDPerMTok).toBe(3.5);
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

  it("gives Gemini, Qwen and GLM the generic tool on the 0–1000 grid, others screenshot pixels", () => {
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
    expect(cap("zai", "glm-5v-turbo")).toMatchObject({ computer: "generic", coords: "per1000" });
    expect(cap("zhipuai", "glm-5v-turbo")).toMatchObject({ coords: "per1000" });
    expect(cap("volcengine", "doubao-seed-2-0-pro-260215")).toMatchObject({ coords: "pixels" });
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
    const compatible = PROVIDERS.filter(
      (p) => p.client === "openai-compatible" && !p.availableIn && !p.plan && !p.notOffered,
    );
    expect(compatible.map((p) => p.id)).toEqual([
      "togetherai",
      "fireworks-ai",
      "cerebras",
      "perplexity",
      "cohere",
      "deepinfra",
      "moonshotai",
      "moonshotai-cn",
      "alibaba",
      "alibaba-cn",
      "zai",
      "zhipuai",
      "minimax",
      "volcengine",
      "siliconflow",
      "siliconflow-cn",
      "openai-compatible",
    ]);
    for (const p of compatible.slice(0, -1)) {
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

describe("custom endpoints", () => {
  it("offer each supported custom API with no address of their own", () => {
    expect(PROVIDERS.filter((p) => p.custom)).toEqual([
      {
        id: "openai-compatible",
        name: "Custom endpoint (OpenAI Chat Completions)",
        client: "openai-compatible",
        keyd: "openai-compatible",
        custom: true,
      },
      {
        id: "openai-responses-compatible",
        name: "Custom endpoint (OpenAI Responses)",
        client: "openai",
        keyd: "openai-compatible",
        custom: true,
      },
      {
        id: "anthropic-compatible",
        name: "Custom endpoint (Anthropic Messages)",
        client: "anthropic-compatible",
        keyd: "anthropic-compatible",
        custom: true,
      },
    ]);
  });

  it("get localDot's computer tool, never Anthropic's own, which needs Anthropic's API", () => {
    const other = providerById("anthropic-compatible");
    if (!other) throw new Error("missing");
    expect(capabilityOf(other, localModel("claude-sonnet-5-5"))).toMatchObject({
      tier: "vision-tools",
      computer: "generic",
    });
    expect(capabilityOf(other, localModel("glm-5.3-flash", { vision: false }))).toMatchObject({
      tier: "text-only",
      computer: "none",
    });
  });
});

describe("the registry against the catalog", () => {
  const listed: Record<string, { api?: string; models: object }> = MODELS_DEV_FIXTURE;
  const trimmed = (url: string) => url.replace(/\/+$/, "");
  // models.dev lists MiniMax by its Anthropic route; localDot pins the OpenAI one.
  const CATALOG_ROUTE: Record<string, string> = {
    minimax: "https://api.minimax.io/anthropic/v1",
    "minimax-coding-plan": "https://api.minimax.io/anthropic/v1",
  };

  it("finds every pinned preset in the catalog at the address the catalog lists", () => {
    const pinned = PROVIDERS.filter((p) => p.baseURL);
    expect(pinned.length).toBeGreaterThan(0);
    for (const p of pinned) {
      const entry = listed[p.id];
      expect(entry, p.id).toBeDefined();
      if (entry?.api) expect(trimmed(entry.api), p.id).toBe(CATALOG_ROUTE[p.id] ?? p.baseURL);
    }
    for (const id of ["zai", "minimax-coding-plan", "alibaba-token-plan", "alibaba-coding-plan"])
      expect(Object.keys(catalog.providers[id]?.models ?? {}).length, id).toBeGreaterThan(0);
  });

  it("offers the plans whose vendors let an agent use them, over the OpenAI-compatible kind", () => {
    const plans = PROVIDERS.filter((p) => p.plan);
    expect(plans.map((p) => [p.id, p.name])).toEqual([
      ["minimax-coding-plan", "MiniMax Token Plan"],
      ["alibaba-token-plan", "Alibaba Token Plan"],
      ["alibaba-coding-plan", "Alibaba Coding Plan"],
    ]);
    for (const p of plans) {
      expect(p).toMatchObject({ client: "openai-compatible", keyd: "openai-compatible" });
      expect(p.baseURL).toMatch(/^https:\/\//);
      expect(p.notOffered).toBeUndefined();
    }
    expect(providerById("alibaba-coding-plan")?.rule).toBe(
      "Alibaba allows this plan only for tasks you start and watch.",
    );
    // models.dev prices plan models at $0.
    expect(findModel(catalog, "minimax-coding-plan", "MiniMax-M3")).toMatchObject({
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
    });
  });

  it("lists the plans it cannot offer with one sentence that points to the vendor's API key", () => {
    const rows = PROVIDERS.filter((p) => p.notOffered);
    expect(rows.map((p) => [p.id, p.name, p.notOffered])).toEqual([
      [
        "zai-coding-plan",
        "GLM Coding Plan",
        "Z.ai lets this plan run only in the coding tools it lists. Use a Z.ai API key here instead.",
      ],
      [
        "kimi-code-plan-global",
        "Kimi For Coding",
        "Kimi lets this plan run only in coding tools it recognises. Use a Moonshot API key here instead.",
      ],
      [
        "volcengine-coding-plan",
        "Ark Coding Plan",
        "Volcengine lets this plan run only in the coding tools it lists. Use an Ark API key here instead.",
      ],
    ]);
    for (const p of rows) {
      expect(listed[p.id], p.id).toBeDefined();
      // Nothing a key could be bound to, and no plan or rule to offer.
      expect(p.baseURL).toBeUndefined();
      expect(p.plan).toBeUndefined();
      expect(p.rule).toBeUndefined();
      expect(p.local).toBeUndefined();
      expect(p.availableIn).toBeUndefined();
    }
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
      "reasoningUSDPerMTok",
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
