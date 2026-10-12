import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SELFTEST_CHECKS } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeDesktopd, probeStream, SELFTEST_TIMEOUT_MS } from "./readiness.ts";
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

  it("checks ongoing desktop health without repeating the boot self-test", async () => {
    const seen: string[] = [];
    const health = { ...notReady, ok: true };
    const baseUrl = await serve((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(health));
    });
    expect(await probeDesktopd({ baseUrl, token: "t" }, 3000, { selftest: false })).toEqual(health);
    expect(seen).toEqual(["/healthz"]);
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

describe("probeDesktopd and the boot self-test", () => {
  const healthy: DesktopdHealth = { ...notReady, ok: true, screen: { w: 2560, h: 1600 } };
  const passing = {
    ok: true,
    ms: 16,
    checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
  };
  const answer =
    (selftest: unknown, status = 200): RequestListener =>
    (req, res) => {
      const body = req.url === "/healthz" ? healthy : selftest;
      res.writeHead(req.url === "/healthz" ? 200 : status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

  it("is ready only when the self-test passes too", async () => {
    const baseUrl = await serve(answer(passing));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toEqual({
      ...healthy,
      ok: true,
      selftest: passing,
    });
  });

  it("is not ready when a check fails, even if the report claims ok", async () => {
    const lying = {
      ...passing,
      checks: passing.checks.map((c) =>
        c.id === "dns" ? { ...c, ok: false, detail: "example.com resolved" } : c,
      ),
    };
    const baseUrl = await serve(answer(lying));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toMatchObject({
      ok: false,
      selftest: lying,
    });
  });

  it("is not ready when the report leaves a check out", async () => {
    const withoutDns = { ...passing, checks: passing.checks.filter((c) => c.id !== "dns") };
    const baseUrl = await serve(answer(withoutDns));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toMatchObject({
      ok: false,
      selftest: withoutDns,
    });
  });

  it("reads the self-test like /healthz: past 64 KiB it counts as no report", async () => {
    const padded = {
      ...passing,
      checks: passing.checks.map((c) => ({ ...c, detail: "x".repeat(450) })),
      pad: "x".repeat(65 * 1024),
    };
    const baseUrl = await serve(answer(padded));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toMatchObject({
      ok: false,
      selftest: { checks: [{ id: "selftest", ok: false }] },
    });
  });

  it("is not ready when desktopd has no self-test or answers something else", async () => {
    for (const [body, status] of [
      [{}, 404],
      [{ ok: true }, 200],
      [{ ok: true, checks: [], ms: 0 }, 200],
    ] as const) {
      const baseUrl = await serve(answer(body, status));
      expect((await probeDesktopd({ baseUrl, token: "t" }))?.ok, JSON.stringify(body)).toBe(false);
      server?.close();
    }
  });

  it("gives the self-test its own, longer timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const baseUrl = await serve(answer(passing));
    await probeDesktopd({ baseUrl, token: "t" });
    expect(timeout.mock.calls).toEqual([[3000], [SELFTEST_TIMEOUT_MS]]);
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

describe("cell-controlled redirects", () => {
  it.each(["/healthz", "/selftest", "/api/health"])(
    "does not follow %s redirects",
    async (path) => {
      let redirected = 0;
      const baseUrl = await serve((req, res) => {
        if (req.url === path) {
          res.writeHead(302, { location: "/unexpected" });
          res.end();
          return;
        }
        if (req.url === "/unexpected") redirected++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            req.url === "/healthz"
              ? { ...notReady, ok: true }
              : {
                  ok: true,
                  ms: 1,
                  checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
                },
          ),
        );
      });
      if (path === "/api/health") {
        expect(await probeStream({ baseUrl, authorization: "Basic eA==" })).toBe(false);
      } else {
        expect((await probeDesktopd({ baseUrl, token: "secret" }))?.ok).not.toBe(true);
      }
      expect(redirected).toBe(0);
    },
  );
});
