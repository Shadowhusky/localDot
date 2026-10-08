import {
  capabilityOf,
  isOpenRouterRouterId,
  normalizeCatalog,
  PROVIDERS,
  providerById,
} from "@localdot/providers";
import { describe, expect, it } from "vitest";
import type { KeyRecord } from "../keys/keys-api.ts";
import {
  customModelAllowed,
  groupOf,
  matchingKeys,
  modelAllowed,
  modelIdProblem,
  PROVIDER_GROUPS,
  planOnly,
  providerAllowed,
  providerName,
} from "./choices.ts";

const key = (provider: string, baseURL?: string): KeyRecord => ({
  id: "stored",
  kind: "llm",
  provider,
  baseURL,
  createdAt: "t",
  updatedAt: "t",
});
describe("provider and model choice rules", () => {
  it("groups every registry row and allows only the offered ones", () => {
    expect(PROVIDER_GROUPS).toEqual([
      "API providers",
      "Compatible providers",
      "Plans",
      "Local servers",
      "Not available here",
      "Later releases",
    ]);
    for (const provider of PROVIDERS) {
      expect(groupOf(provider)).toBe(
        provider.availableIn
          ? "Later releases"
          : provider.notOffered
            ? "Not available here"
            : provider.local
              ? "Local servers"
              : provider.plan
                ? "Plans"
                : provider.client === "openai-compatible" || provider.custom
                  ? "Compatible providers"
                  : "API providers",
      );
      const offered = !provider.availableIn && !provider.notOffered;
      expect(providerAllowed("main", provider)).toBe(offered);
      expect(providerAllowed("fast", provider)).toBe(offered);
      expect(providerAllowed("local", provider)).toBe(provider.local === true && offered);
    }
    expect(groupOf(providerById("anthropic-compatible") as never)).toBe("Compatible providers");
    expect(PROVIDERS.filter((p) => groupOf(p) === "Plans").map((p) => p.id)).toEqual([
      "minimax-coding-plan",
      "alibaba-token-plan",
      "alibaba-coding-plan",
    ]);
    expect(PROVIDERS.filter((p) => groupOf(p) === "Not available here").map((p) => p.id)).toEqual([
      "zai-coding-plan",
      "kimi-code-plan-global",
      "volcengine-coding-plan",
    ]);
  });
  it("binds no key and no typed model to a plan that is not offered", () => {
    for (const provider of PROVIDERS.filter((p) => p.notOffered)) {
      expect(
        matchingKeys(provider, [key("openai-compatible", "https://api.z.ai/api/coding/paas/v4")]),
      ).toEqual([]);
      expect(customModelAllowed(provider)).toBe(false);
    }
  });
  it("calls a choice plan-only when no role is billed and one runs on a plan", () => {
    const plan = { provider: "alibaba-token-plan", model: "qwen3.8-max", key: "plan" };
    const local = { provider: "lmstudio", model: "local" };
    expect(planOnly({ main: plan })).toBe(true);
    expect(planOnly({ main: plan, local })).toBe(true);
    expect(planOnly({ main: plan, fast: { provider: "openai", model: "m", key: "k" } })).toBe(
      false,
    );
    expect(planOnly({ main: plan, fast: { provider: "", model: "" } })).toBe(false);
    expect(planOnly({ main: local })).toBe(false);
    expect(planOnly({})).toBe(false);
    // A custom endpoint is on a plan when its user says so.
    const custom = { provider: "anthropic-compatible", model: "glm-5.3-flash", key: "anc" };
    expect(planOnly({ main: { ...custom, plan: true } })).toBe(true);
    expect(planOnly({ main: { ...custom, plan: true }, local })).toBe(true);
    expect(planOnly({ main: custom })).toBe(false);
    expect(planOnly({ main: { ...plan, plan: true }, fast: { ...custom } })).toBe(false);
  });
  it("matches every compatible preset by kind AND canonical bound URL", () => {
    for (const provider of PROVIDERS.filter((p) => p.baseURL)) {
      expect(matchingKeys(provider, [key(provider.keyd, `${provider.baseURL}/`)])).toHaveLength(1);
      for (const candidate of [
        key("anthropic", provider.baseURL),
        key(provider.keyd, "https://wrong.example/v1"),
        key(provider.keyd),
        key(provider.keyd, `${provider.baseURL}?redirect=1`),
        { ...key(provider.keyd, provider.baseURL), kind: "http" as const },
      ]) {
        expect(matchingKeys(provider, [candidate])).toEqual([]);
      }
    }
  });
  it("keeps first-class names exact, permits bound Other/Azure metadata and never requires a local key", () => {
    for (const provider of PROVIDERS.filter(
      (p) => !p.baseURL && !p.local && !p.availableIn && !p.notOffered,
    )) {
      expect(matchingKeys(provider, [key(provider.keyd, "https://owned.example/v1")])).toHaveLength(
        1,
      );
      expect(matchingKeys(provider, [key("wrong")])).toEqual([]);
    }
    for (const id of ["lmstudio", "ollama"]) {
      const provider = providerById(id);
      if (!provider) throw new Error("missing accepted provider");
      expect(matchingKeys(provider, [key(id)])).toEqual([]);
      expect(customModelAllowed(provider)).toBe(true);
    }
  });
  it("supports custom IDs only where the accepted resolver supports them", () => {
    for (const provider of PROVIDERS)
      expect(customModelAllowed(provider)).toBe(
        !provider.availableIn &&
          (provider.local === true ||
            provider.id === "openai-compatible" ||
            provider.id === "anthropic-compatible"),
      );
    expect(modelIdProblem("Qwen/model:v2@preview+1")).toBeNull();
    for (const id of ["", " x", "../model", "x".repeat(129), "模型"])
      expect(modelIdProblem(id)).toBeTruthy();
  });
  it("uses accepted normalization to exclude explicit embedding-only output while keeping unknown/absent modalities", () => {
    const raw = {
      openai: {
        models: {
          embed: { id: "embed", modalities: { output: ["embedding"] } },
          absent: { id: "absent", tool_call: true },
          unknown: { id: "unknown", modalities: { output: [] } },
          text: { id: "text", modalities: { output: ["text"] }, tool_call: true },
        },
      },
    };
    const catalog = normalizeCatalog(raw, "fixture");
    const models = Object.values(catalog.providers.openai?.models ?? {});
    expect(models.map((m) => m.id)).toEqual(["absent", "unknown", "text"]);
    const provider = providerById("openai");
    if (!provider) throw new Error("missing provider");
    const caps = models.map((m) => capabilityOf(provider, m));
    expect(
      caps.map((m) =>
        modelAllowed("main", {
          ...m,
          id: "m",
          name: "m",
          contextTokens: 1,
          inputUSDPerMTok: 1,
          outputUSDPerMTok: 1,
        }),
      ),
    ).toEqual([true, false, true]);
    expect(
      caps.every((m) =>
        modelAllowed("fast", {
          ...m,
          id: "m",
          name: "m",
          contextTokens: 1,
          inputUSDPerMTok: 1,
          outputUSDPerMTok: 1,
        }),
      ),
    ).toBe(true);
  });
  it("rejects the shared router ID rule without treating a specific hosted model as a router", () => {
    for (const id of ["openrouter/auto", "OpenRouter/anything"])
      expect(isOpenRouterRouterId("openrouter", id)).toBe(true);
    expect(isOpenRouterRouterId("openrouter", "anthropic/fixed-model")).toBe(false);
    expect(isOpenRouterRouterId("other", "openrouter/auto")).toBe(false);
  });
});
describe("provider names", () => {
  it("names a provider as the registry does, and the ChatGPT plan by its own name", () => {
    expect(providerName("minimax-coding-plan")).toBe("MiniMax Token Plan");
    expect(providerName("chatgpt")).toBe("ChatGPT plan");
    expect(providerName("retired-provider")).toBe("retired-provider");
  });
});
