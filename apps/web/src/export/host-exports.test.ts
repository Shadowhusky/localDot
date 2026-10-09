// @vitest-environment jsdom
import type { ExportsState } from "@localdot/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { hostExport } from "../testing/host-export.ts";
import { createHostExports, hostCanMake } from "./host-exports.ts";

const TOKEN = "a".repeat(43);
const ORIGIN = "http://127.0.0.1:4750";
const READY: ExportsState = {
  host: { state: "ready", maxPixels: { mp4: 4_096_000, webm: 4_096_000 } },
  exports: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function daemon(answer: (method: string, path: string) => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
    calls.push(call);
    return answer(init?.method ?? "GET", new URL(String(input)).pathname);
  }) as typeof fetch;
  return { api: createApi(TOKEN, { fetchImpl, origin: ORIGIN }), calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("lists the host's videos, then follows them over a socket", async () => {
  const { api } = daemon(() => json(READY));
  const exports = createHostExports(api);
  expect(exports.view().host).toBeNull();
  await settle();
  expect(hostCanMake(exports.view())).toBe(true);
  const socket = FakeWebSocket.instances[0] as FakeWebSocket;
  expect(socket.url).toBe("ws://127.0.0.1:4750/api/exports/stream");
  const made = hostExport({ done: 450, total: 1800 });
  const seen = vi.fn();
  exports.subscribe(seen);
  socket.onmessage?.({ data: JSON.stringify({ ...READY, exports: [made] }) });
  expect(exports.view().exports).toEqual([made]);
  expect(seen).toHaveBeenCalledTimes(1);
  socket.onmessage?.({ data: JSON.stringify({ host: "nonsense" }) });
  expect(exports.view().exports).toEqual([made]);
  exports.dispose();
  expect(socket.closed).toBe(true);
});

it("opens no socket to a daemon that can't make videos in the background", async () => {
  const { api } = daemon(() => new Response("not found", { status: 404 }));
  const exports = createHostExports(api);
  await settle();
  expect(exports.view()).toEqual({ host: null, exports: [] });
  expect(FakeWebSocket.instances).toHaveLength(0);
  expect(hostCanMake(exports.view())).toBe(false);
});

it("asks again when the page comes back after the host could not be reached", async () => {
  let reachable = false;
  const { api, calls } = daemon(() =>
    reachable ? json(READY) : new Response("restarting", { status: 503 }),
  );
  const exports = createHostExports(api);
  await settle();
  expect(exports.view().host).toBeNull();
  reachable = true;
  window.dispatchEvent(new Event("online"));
  await settle();
  expect(hostCanMake(exports.view())).toBe(true);
  expect(FakeWebSocket.instances).toHaveLength(1);
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(calls).toEqual(["GET /api/exports", "GET /api/exports"]);
  exports.dispose();
});

it("starts, cancels, retries, removes and links by the host's routes", async () => {
  const made = hostExport();
  const { api, calls } = daemon((method, path) => {
    if (path === "/api/exports" && method === "POST") return json(made, 201);
    if (path.endsWith("/retry")) return json({ ...made, phase: "queued" });
    if (path.endsWith("/link")) return json({ href: `/export-files/${"T".repeat(43)}` });
    if (method === "DELETE" || path.endsWith("/cancel")) return new Response(null, { status: 204 });
    return json(READY);
  });
  const exports = createHostExports(api);
  await settle();
  expect(await exports.start({ request: made.request, screen: "desktop" })).toEqual(made);
  expect(exports.view().exports).toEqual([made]);
  await exports.cancel(made.id);
  await exports.retry(made.id);
  expect(exports.view().exports[0]?.phase).toBe("queued");
  expect(await exports.link(made.id)).toBe(`${ORIGIN}/export-files/${"T".repeat(43)}`);
  await exports.remove(made.id);
  expect(exports.view().exports).toEqual([]);
  expect(calls).toEqual([
    "GET /api/exports",
    "POST /api/exports",
    `POST /api/exports/${made.id}/cancel`,
    `POST /api/exports/${made.id}/retry`,
    `POST /api/exports/${made.id}/link`,
    `DELETE /api/exports/${made.id}`,
  ]);
  await expect(exports.cancel("../daemon-token")).rejects.toThrow(RangeError);
});
