import type { ApiRequestInput, KeydRecord } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { ServiceKeys } from "./service-keys.ts";

const key: KeydRecord = {
  id: "studio",
  kind: "llm",
  provider: "openai",
  metadata: { label: "Studio", service: "Acme", description: "Search catalog" },
  createdAt: "",
  updatedAt: "",
  usage: {
    hosts: ["api.example.test"],
    baseURL: "https://api.example.test/v1",
    header: "Authorization",
    format: "bearer",
    paths: ["/v1"],
  },
};
const token = `ld_oai_${"a".repeat(22)}_${"b".repeat(6)}`;
function fixture() {
  const keyd = {
    secrets: vi.fn(async () => [key]),
    openCell: vi.fn(async (r: { cellId: string; port: number }) => ({
      ...r,
      proxyToken: "x".repeat(43),
      caCertPem: "",
      caPath: "",
      surrogates: { studio: token },
    })),
    closeCell: vi.fn(async () => true),
  };
  const ports = { reserve: vi.fn(() => 4789), release: vi.fn() };
  const fetch = vi.fn(
    async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
  );
  const service = new ServiceKeys({ keyd, ports, fetch: fetch as never });
  const call = (input: Partial<ApiRequestInput> = {}) =>
    service.request(
      { key_id: "studio", url: "https://api.example.test/v1/search", method: "POST", ...input },
      Buffer.from("{}"),
      new AbortController().signal,
    );
  return { keyd, ports, fetch, service, call };
}
describe("saved service keys", () => {
  it("discovers by description and uses the same provider credential through an isolated listener", async () => {
    const f = fixture();
    expect(await f.service.list("catalog")).toEqual([key]);
    expect(await f.service.list("missing")).toEqual([]);
    const result = await f.call();
    expect(result.status).toBe(200);
    expect(f.keyd.openCell).toHaveBeenCalledWith(
      expect.objectContaining({ role: "service", secrets: ["studio"] }),
    );
    expect(f.fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
        redirect: "manual",
      }),
    );
    expect(f.keyd.closeCell).toHaveBeenCalledOnce();
    expect(f.ports.release).toHaveBeenCalledWith(4789);
  });
  it.each([
    "https://evil.example.test/v1",
    "http://api.example.test/v1",
    "https://api.example.test/v1-admin",
    "https://api.example.test:8443/v1",
    "https://user:pass@api.example.test/v1",
  ])("rejects a mismatched destination %s before opening a connection", async (url) => {
    const f = fixture();
    await expect(f.call({ url })).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.keyd.openCell).not.toHaveBeenCalled();
  });
  it.each(["Authorization", "Cookie", "Proxy-Authorization", "Content-Length", "Host"])(
    "does not accept model-supplied %s",
    async (header) => {
      const f = fixture();
      await expect(f.call({ headers: { [header]: "anything" } })).rejects.toThrow();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it("refuses revoked and unavailable keys", async () => {
    const f = fixture();
    f.keyd.secrets.mockResolvedValue([{ ...key, reenter: true }]);
    await expect(f.call()).rejects.toThrow("attention");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("never retries a write or follows redirects", async () => {
    const f = fixture();
    f.fetch.mockRejectedValueOnce(new Error("lost response"));
    await expect(f.call()).rejects.toThrow("may have completed");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.ports.release).toHaveBeenCalledOnce();
    f.fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
    );
    await expect(f.call()).rejects.toThrow("redirected");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("bounds preview size and releases the listener on failed opens", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response("x".repeat(40000)));
    const r = await f.call();
    expect(r.body.length).toBe(32768);
    expect(r.truncated).toBe(true);
    f.keyd.openCell.mockRejectedValueOnce(new Error("offline"));
    await expect(f.call()).rejects.toThrow();
    expect(f.ports.release).toHaveBeenCalledTimes(2);
  });
});

it("waits for active requests to close and does not recycle an unconfirmed listener port", async () => {
  const f = fixture();
  f.keyd.closeCell.mockRejectedValueOnce(new Error("offline"));
  await expect(f.call()).rejects.toThrow("cleanup");
  expect(f.ports.release).not.toHaveBeenCalled();
  await f.service.close();
  expect(f.ports.release).toHaveBeenCalledOnce();
});
it("shutdown aborts a service call, drains its cleanup and refuses new calls", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  f.fetch.mockImplementationOnce((async (_url: unknown, options: { signal: AbortSignal }) => {
    started.resolve();
    await new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as never);
  const request = f.call().catch((error) => error);
  await started.promise;
  await f.service.close();
  expect(await request).toBeInstanceOf(Error);
  expect(f.keyd.closeCell).toHaveBeenCalledOnce();
  expect(f.ports.release).toHaveBeenCalledOnce();
  await expect(f.call()).rejects.toThrow("busy");
});

it("lists general keys by purpose but never opens an API connection for one", async () => {
  const f = fixture();
  const record: KeydRecord = {
    id: "license",
    kind: "secret",
    metadata: { label: "Build license", description: "Project build" },
    createdAt: "",
    updatedAt: "",
  };
  f.keyd.secrets.mockResolvedValue([record]);
  expect(await f.service.list("build")).toEqual([record]);
  await expect(f.call({ key_id: "license" })).rejects.toThrow("no API binding");
  expect(f.keyd.openCell).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});
