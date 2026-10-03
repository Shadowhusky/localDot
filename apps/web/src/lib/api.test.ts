// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api.ts";

const TOKEN = "t".repeat(43);
const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });

describe("createApi", () => {
  it("provides PUT with the same bearer and JSON handling as other protected requests", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { taskBudgetUSD: 2 }));
    const api = createApi(TOKEN, { fetchImpl, origin: "http://fixture" });
    expect(await api.put("/api/agent/settings", { taskBudgetUSD: 2 })).toEqual({
      taskBudgetUSD: 2,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://fixture/api/agent/settings");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe('{"taskBudgetUSD":2}');
  });
  it("sends the bearer token, JSON bodies, and parses replies", async () => {
    const fetchImpl = vi.fn(async () => reply(202, { id: "x" }));
    const api = createApi(TOKEN, { fetchImpl, origin: "http://127.0.0.1:4750" });
    expect(await api.post("/api/cells", { scale: 2 })).toEqual({ id: "x" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4750/api/cells");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe('{"scale":2}');
  });

  it("resolves undefined for empty replies and throws ApiError with the body text otherwise", async () => {
    const api = createApi(TOKEN, { fetchImpl: async () => reply(204), origin: "http://x" });
    await expect(api.del("/api/cells/1")).resolves.toBeUndefined();
    const failing = createApi(TOKEN, {
      fetchImpl: async () => new Response("cell is starting", { status: 409 }),
      origin: "http://x",
    });
    const err = await failing.post("/api/cells/1/stream-ticket").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: "cell is starting" });
  });

  it("reports a 401 once through onUnauthorized and throws", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi(TOKEN, {
      fetchImpl: async () => reply(401),
      origin: "http://x",
      onUnauthorized,
    });
    await expect(api.get("/api/whoami")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("builds WebSocket URLs and offers both subprotocols", () => {
    const api = createApi(TOKEN, { origin: "http://127.0.0.1:4750" });
    expect(api.socketUrl("/api/cells/1/status")).toBe("ws://127.0.0.1:4750/api/cells/1/status");
    expect(api.socketProtocols()).toEqual(["localdot.v1", `localdot.token.${TOKEN}`]);
  });
});
