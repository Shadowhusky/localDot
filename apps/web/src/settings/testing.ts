import { capabilityOf, normalizeCatalog, PROVIDERS } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import type { WhatDotKnows } from "./memory/useWhatDotKnows.ts";
import type { ProviderIndex } from "./settings-api.ts";

// Test-only metadata. No production module imports this file.
export function providerFixture(): ProviderIndex {
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-03T00:00:00Z");
  return {
    catalog: { fetchedAt: catalog.fetchedAt, skipped: catalog.skipped },
    keyLayer: "online",
    subscriptions: [
      { id: "chatgpt", name: "ChatGPT plan", available: false, reason: "fixture not installed" },
    ],
    keys: [
      { id: "anthropic", provider: "anthropic" },
      { id: "openai", provider: "openai" },
      { id: "gateway", provider: "openai-compatible", baseURL: "https://example.test/v1" },
    ],
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      keyd: p.keyd,
      local: p.local === true,
      ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      ...(p.availableIn ? { availableIn: p.availableIn } : {}),
      ...(p.plan ? { plan: p.plan } : {}),
      ...(p.rule ? { rule: p.rule } : {}),
      ...(p.notOffered ? { notOffered: p.notOffered } : {}),
      models: Object.values(
        !p.notOffered && Object.hasOwn(catalog.providers, p.id)
          ? (catalog.providers[p.id]?.models ?? {})
          : {},
      ).map((m) => ({
        id: m.id,
        name: m.name,
        contextTokens: m.contextTokens,
        inputUSDPerMTok: m.inputUSDPerMTok,
        outputUSDPerMTok: m.outputUSDPerMTok,
        ...capabilityOf(p, m),
      })),
    })),
  };
}

export function knownFixture(over: Partial<WhatDotKnows> = {}): WhatDotKnows {
  const unused = async (): Promise<never> => {
    throw new Error("fixture write");
  };
  return {
    phase: "ready",
    dir: "~/.localdot/memory",
    files: { "USER.md": [], "MEMORY.md": [] },
    notes: [],
    people: [],
    recent: [],
    reload: () => {},
    addFact: unused,
    editFact: unused,
    deleteFact: unused,
    undo: unused,
    addPerson: unused,
    editPerson: unused,
    deletePerson: unused,
    ...over,
  };
}
