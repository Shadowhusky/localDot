import { DEFAULT_NOTIFY_SETTINGS, type NotifySettings } from "@localdot/protocol";
import { capabilityOf, normalizeCatalog, PROVIDERS } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { createApi } from "../lib/api.ts";
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

// The daemon's notification routes, in memory: settings, no phones, a test that reaches this Mac.
export function notifyDaemonFixture(failSave = false) {
  let settings: NotifySettings = DEFAULT_NOTIFY_SETTINGS;
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === "/api/notify/settings" && method === "PUT") {
      if (failSave)
        return new Response("Quiet hours need different start and end times.", { status: 400 });
      settings = JSON.parse(String(init?.body)) as NotifySettings;
      return Response.json(settings);
    }
    if (path === "/api/notify/settings") return Response.json(settings);
    if (path === "/api/notify/subscriptions") return Response.json({ devices: [] });
    if (path === "/api/notify/test") return Response.json({ mac: "shown", phones: [] });
    if (path === "/api/install-code") return Response.json({ code: "C".repeat(43), expiresAt: 1 });
    return new Response("not found", { status: 404 });
  };
  const api = createApi("t".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: fetchImpl as typeof fetch,
  });
  return { api, calls, current: () => settings };
}
