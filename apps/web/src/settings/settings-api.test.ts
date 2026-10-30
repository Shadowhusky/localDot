// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import {
  loadProviderIndex,
  loadSettings,
  type ProviderIndex,
  refreshCatalog,
  saveSettings,
} from "./settings-api.ts";
import { providerFixture } from "./testing.ts";

const apiFor = (fetchImpl: typeof fetch, onUnauthorized?: () => void) =>
  createApi("fixture-token", { origin: "http://fixture", fetchImpl, onUnauthorized });
describe("bounded authenticated settings wire", () => {
  it("parses only the whole supported settings document and canonical provider metadata", async () => {
    const data = {
      main: { provider: "ollama", model: "local" },
      codexDenyRead: ["/private/fixture"],
      taskBudgetUSD: 2,
    };
    const api = apiFor(async (url) =>
      Response.json(String(url).endsWith("providers") ? providerFixture() : data),
    );
    expect(await loadSettings(api)).toEqual(data);
    expect(await loadProviderIndex(api)).toEqual(providerFixture());
    const incompatible = apiFor(async () => Response.json({ ...data, unknown: 1 }));
    await expect(loadSettings(incompatible)).rejects.toMatchObject({ uncertain: false });
    const duplicate = providerFixture();
    duplicate.providers[1] = duplicate.providers[0] as (typeof duplicate.providers)[number];
    await expect(
      loadProviderIndex(apiFor(async () => Response.json(duplicate))),
    ).rejects.toMatchObject({ uncertain: false });
  });
  it("takes plan, rule and not-offered metadata only as the registry states it", async () => {
    const index = await loadProviderIndex(apiFor(async () => Response.json(providerFixture())));
    const row = (id: string) => index.providers.find((p) => p.id === id);
    expect(row("minimax-coding-plan")).toMatchObject({ plan: true });
    expect(row("alibaba-coding-plan")?.rule).toBe(
      "Alibaba allows this plan only for tasks you start and watch.",
    );
    expect(row("zai-coding-plan")).toMatchObject({
      notOffered: expect.stringMatching(/^Z\.ai lets this plan run only/),
      models: [],
    });
    const forged = (id: string, change: (row: ProviderIndex["providers"][number]) => void) => {
      const index = providerFixture();
      const row = index.providers.find((p) => p.id === id);
      if (row) change(row);
      return loadProviderIndex(apiFor(async () => Response.json(index)));
    };
    const zaiModels = row("zai")?.models ?? [];
    for (const attempt of [
      forged("zai", (p) => {
        p.plan = true;
      }),
      forged("alibaba-coding-plan", (p) => {
        p.rule = "Use it anywhere.";
      }),
      forged("zai-coding-plan", (p) => {
        delete p.notOffered;
      }),
      forged("zai-coding-plan", (p) => {
        p.models = zaiModels;
      }),
    ])
      await expect(attempt).rejects.toMatchObject({ uncertain: false });
  });
  it("accepts a refresh of the whole catalog, which lists far more providers than localDot", async () => {
    const reply = { fetchedAt: "2026-10-08T11:38:41.404Z", providers: 226, skipped: 281 };
    await expect(refreshCatalog(apiFor(async () => Response.json(reply)))).resolves.toBeUndefined();
    for (const providers of [-1, 1.5, "226"])
      await expect(
        refreshCatalog(apiFor(async () => Response.json({ ...reply, providers }))),
      ).rejects.toMatchObject({ uncertain: false });
  });
  it("sends a snapshotted PUT once, with the bearer header and no unknown fields", async () => {
    const data = {
      main: {
        provider: "openai-compatible",
        model: "custom",
        key: "gateway",
        price: { inputUSDPerMTok: 0, outputUSDPerMTok: 2 },
      },
      taskBudgetUSD: 3,
    };
    const fetchImpl = vi.fn(async (_url, init) =>
      Response.json(JSON.parse(String(init?.body))),
    ) as unknown as typeof fetch;
    expect(await saveSettings(apiFor(fetchImpl), data)).toEqual(data);
    const mock = vi.mocked(fetchImpl);
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0]?.[0]).toBe("http://fixture/api/agent/settings");
    expect(mock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer fixture-token",
    );
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toEqual(data);
  });
  it("takes the daemon's list of model choices not in use, which it keeps itself", async () => {
    const haiku = { provider: "claude-code", model: "haiku" };
    const data = {
      main: { provider: "claude-code", model: "opus" },
      fast: haiku,
      models: [haiku, { provider: "claude-code", model: "sonnet" }],
    };
    const reply = { ...data, models: [{ provider: "claude-code", model: "sonnet" }] };
    expect(
      await saveSettings(
        apiFor(async () => Response.json(reply)),
        data,
      ),
    ).toEqual(reply);
    await expect(
      saveSettings(
        apiFor(async () => Response.json({ ...reply, fast: undefined })),
        data,
      ),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it("refuses invalid numeric values locally before network, without clipping an oversized value", async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    for (const price of [
      { inputUSDPerMTok: 10_001, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: 0, outputUSDPerMTok: 0 },
      { inputUSDPerMTok: 1 },
      { inputUSDPerMTok: NaN, outputUSDPerMTok: 1 },
    ])
      await expect(
        saveSettings(apiFor(fetchImpl), {
          main: { provider: "openai-compatible", model: "custom", key: "gateway", price },
        } as never),
      ).rejects.toMatchObject({ uncertain: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("distinguishes a verified refusal from a lost, malformed or mismatched write acknowledgement", async () => {
    const data = { main: { provider: "ollama", model: "local" } };
    for (const status of [400, 401, 403, 404, 409, 413, 422])
      await expect(
        saveSettings(
          apiFor(async () => new Response("private-server-detail", { status })),
          data,
        ),
      ).rejects.toMatchObject({ uncertain: false, status });
    for (const response of [
      new Response(null, { status: 204 }),
      Response.json({}, { status: 200 }),
      new Response("private-server-detail", { status: 502 }),
      Response.json({ ...data, extra: 1 }),
    ]) {
      const error = await saveSettings(
        apiFor(async () => response),
        data,
      ).catch((e) => e);
      expect(error).toMatchObject({ uncertain: true });
      expect(error.message).not.toContain("private-server-detail");
    }
    await expect(
      saveSettings(
        apiFor(async () => {
          throw new Error("private-network-detail");
        }),
        data,
      ),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it("routes raw 401 reads/writes through the same captured unauthorized callback without retry", async () => {
    const rejected = vi.fn(),
      fetchImpl = vi.fn(async () => new Response("private-detail", { status: 401 }));
    const api = apiFor(fetchImpl, rejected);
    await expect(loadSettings(api)).rejects.toMatchObject({ status: 401 });
    await expect(saveSettings(api, {})).rejects.toMatchObject({ status: 401 });
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("cancels a growing response at its byte bound even without a Content-Length", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel: cancelled,
    });
    await expect(loadSettings(apiFor(async () => new Response(stream)))).rejects.toMatchObject({
      uncertain: false,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("keeps cancellation live after headers and through response body consumption", async () => {
    const reading = Promise.withResolvers<void>(),
      abort = new AbortController(),
      cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"main":'));
      },
      pull() {
        reading.resolve();
      },
      cancel: cancelled,
    });
    const pending = loadSettings(
      apiFor(async () => new Response(stream)),
      abort.signal,
    );
    await reading.promise;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ uncertain: false });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("rejects invalid UTF-8 instead of converting damaged bytes into a saved value", async () => {
    await expect(
      loadSettings(apiFor(async () => new Response(new Uint8Array([0xff, 0xfe])))),
    ).rejects.toMatchObject({ uncertain: false });
  });
});
