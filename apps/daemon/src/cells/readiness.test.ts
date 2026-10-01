import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeDesktopd, probeStream } from "./readiness.ts";
import type { DesktopdHealth } from "./types.ts";

const notReady: DesktopdHealth = {
  ok: false,
  scale: 2,
  display: ":1",
  screen: null,
  hidpi: {
    ok: false,
    expected: { windowScalingFactor: 2, xftDpi: 96 },
    windowScalingFactor: null,
    xftDpi: null,
  },
};

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  const s = server;
  server = undefined;
  if (!s) return;
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
});

async function serve(handler: RequestListener): Promise<string> {
  const s = createServer(handler);
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const silent: RequestListener = () => {};

describe("probeDesktopd", () => {
  it("asks /healthz with the cell's bearer token and hands back a not-ready answer as it is", async () => {
    const seen: { url?: string; authorization?: string }[] = [];
    const baseUrl = await serve((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(notReady));
    });
    expect(await probeDesktopd({ baseUrl, token: "t0ken" })).toEqual(notReady);
    expect(seen).toEqual([{ url: "/healthz", authorization: "Bearer t0ken" }]);
  });

  it("gives no answer when desktopd refuses the token, whatever the refusal carries", async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...notReady, ok: true }));
    });
    expect(await probeDesktopd({ baseUrl, token: "wrong" })).toBeUndefined();
  });

  it("stops waiting for a desktopd that never answers", async () => {
    const baseUrl = await serve(silent);
    const started = Date.now();
    expect(await probeDesktopd({ baseUrl, token: "t" }, 50)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("probeDesktopd's limits", () => {
  const answering = (body: string) =>
    serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });

  it("reads an answer of up to 64 KiB", async () => {
    const health = { ...notReady, pad: "x".repeat(60 * 1024) };
    const baseUrl = await answering(JSON.stringify(health));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toEqual(health);
  });

  it("gives no answer for a body past 64 KiB, however it ends", async () => {
    const baseUrl = await answering(
      JSON.stringify({ ...notReady, ok: true, pad: "x".repeat(65 * 1024) }),
    );
    expect(await probeDesktopd({ baseUrl, token: "t" })).toBeUndefined();
  });

  it.each([
    ["ok is a string", JSON.stringify({ ...notReady, ok: "true" })],
    ["ok is missing", JSON.stringify({ ...notReady, ok: undefined })],
    ["the answer is not an object", "[true]"],
    ["the answer is null", "null"],
  ])("gives no answer when %s", async (_what, body) => {
    const baseUrl = await answering(body);
    expect(await probeDesktopd({ baseUrl, token: "t" })).toBeUndefined();
  });
});

describe("probeStream", () => {
  it("asks Selkies' /api/health with the cell's basic credentials", async () => {
    const seen: { url?: string; authorization?: string }[] = [];
    const baseUrl = await serve((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(req.headers.authorization === "Basic b2s=" ? 200 : 401);
      res.end();
    });
    expect(await probeStream({ baseUrl, authorization: "Basic b2s=" })).toBe(true);
    expect(await probeStream({ baseUrl, authorization: "Basic bm8=" })).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(["/api/health", "/api/health"]);
  });

  it("stops waiting for a stream that never answers", async () => {
    const baseUrl = await serve(silent);
    const started = Date.now();
    expect(await probeStream({ baseUrl, authorization: "Basic eA==" }, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("probe timeouts", () => {
  it("bound each request at 3 s unless told otherwise", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(notReady));
    });
    await probeDesktopd({ baseUrl, token: "t" });
    await probeStream({ baseUrl, authorization: "Basic eA==" });
    expect(timeout.mock.calls).toEqual([[3000], [3000]]);
  });
});
