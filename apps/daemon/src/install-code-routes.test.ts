import type { AccessLinksStatus } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import type { EventLog } from "./event-log.ts";
import { setPublicOrigin } from "./guard.ts";
import { InstallCodes } from "./install-codes.ts";

const TOKEN = "t".repeat(43),
  PORT = 4750,
  ORIGIN = `http://127.0.0.1:${PORT}`;
const headers = { origin: ORIGIN, "content-type": "application/json" };
function fixture() {
  const codes = new InstallCodes(TOKEN, PORT);
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog: {} as EventLog,
    installCodes: codes,
  });
  return {
    codes,
    app,
    exchange: (code: string) =>
      app.request(`${ORIGIN}/auth/exchange-code`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code }),
      }),
  };
}

describe("install code HTTP boundary without a listener", () => {
  it("atomically exchanges only one concurrent request and never caches the token", async () => {
    const f = fixture(),
      issued = f.codes.issue();
    const replies = await Promise.all([f.exchange(issued.code), f.exchange(issued.code)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
    const success = replies.find((reply) => reply.status === 200);
    expect(await success?.json()).toEqual({ token: TOKEN });
    for (const reply of replies) {
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(reply.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
  it("requires bearer authority to issue a new link", async () => {
    const f = fixture();
    expect((await f.app.request(`${ORIGIN}/api/install-code`, { method: "POST" })).status).toBe(
      401,
    );
    const result = await f.app.request(`${ORIGIN}/api/install-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(result.status).toBe(200);
    const issued = (await result.json()) as { code: string; expiresAt: number };
    expect(Object.keys(issued).sort()).toEqual(["code", "expiresAt"]);
    expect(await (await f.exchange(issued.code)).json()).toEqual({ token: TOKEN });
  });
  it.each([
    undefined,
    "null",
    "http://evil.test",
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT + 1}`,
  ])(
    "refuses missing or nonmatching browser origin without consuming the code %#",
    async (origin) => {
      const f = fixture(),
        issued = f.codes.issue();
      const result = await f.app.request(`${ORIGIN}/auth/exchange-code`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ code: issued.code }),
      });
      expect(result.status).toBe(403);
      expect((await f.exchange(issued.code)).status).toBe(200);
    },
  );
  it.each(["GET", "HEAD", "PUT"])("refuses %s without consuming the code", async (method) => {
    const f = fixture(),
      issued = f.codes.issue();
    expect(
      (await f.app.request(`${ORIGIN}/auth/exchange-code`, { method, headers })).status,
    ).not.toBe(200);
    expect((await f.exchange(issued.code)).status).toBe(200);
  });
  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])(
    "refuses %s bodies",
    async (type) => {
      const f = fixture(),
        issued = f.codes.issue();
      const result = await f.app.request(`${ORIGIN}/auth/exchange-code`, {
        method: "POST",
        headers: { ...headers, "content-type": type },
        body: JSON.stringify({ code: issued.code }),
      });
      expect(result.status).toBe(415);
      expect((await f.exchange(issued.code)).status).toBe(200);
    },
  );
  it("refuses ambiguous, excessive and query-carried credentials without echoing them", async () => {
    const f = fixture(),
      { code } = f.codes.issue();
    for (const body of [
      JSON.stringify({ code, extra: true }),
      `{"code":"${code}","code":"${code}"}`,
      JSON.stringify({ token: code }),
      "x".repeat(129),
    ]) {
      const reply = await f.app.request(`${ORIGIN}/auth/exchange-code`, {
        method: "POST",
        headers,
        body,
      });
      expect([400, 413]).toContain(reply.status);
      expect(await reply.text()).not.toContain(code);
    }
    const query = await f.app.request(`${ORIGIN}/auth/exchange-code?code=${code}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
    });
    expect(query.status).toBe(400);
    expect((await f.exchange(code)).status).toBe(200);
  });
  it("refuses a foreign Host header and cookie-only credentials", async () => {
    const f = fixture(),
      { code } = f.codes.issue();
    const host = await f.app.request(`${ORIGIN}/auth/exchange-code`, {
      method: "POST",
      headers: { ...headers, host: "evil.test" },
      body: JSON.stringify({ code }),
    });
    expect(host.status).toBe(403);
    const cookie = await f.app.request(`${ORIGIN}/auth/exchange-code`, {
      method: "POST",
      headers: { ...headers, cookie: `code=${code}; token=${TOKEN}` },
      body: "{}",
    });
    expect(cookie.status).toBe(400);
    expect((await f.exchange(code)).status).toBe(200);
  });
  it("refuses a store belonging to another daemon", () => {
    expect(() =>
      createApp({
        token: TOKEN,
        port: PORT,
        eventLog: {} as EventLog,
        installCodes: new InstallCodes("x".repeat(43), PORT),
      }),
    ).toThrow();
  });
  it("bounds actual streamed bytes even when the advertised length is small", async () => {
    const f = fixture(),
      { code } = f.codes.issue();
    const request = new Request(`${ORIGIN}/auth/exchange-code`, {
      method: "POST",
      headers: { ...headers, "content-length": "1" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(129));
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await f.app.request(request)).status).toBe(413);
    expect((await f.exchange(code)).status).toBe(200);
  });
  it("bounds a stalled request without consuming its code", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(),
        { code } = f.codes.issue();
      const cancelled = vi.fn();
      const request = new Request(`${ORIGIN}/auth/exchange-code`, {
        method: "POST",
        headers,
        body: new ReadableStream({ cancel: cancelled }),
        duplex: "half",
      } as RequestInit);
      const pending = f.app.request(request);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await pending).status).toBe(408);
      expect(cancelled).toHaveBeenCalledOnce();
      expect((await f.exchange(code)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refuses noncanonical JSON and encoding without consuming valid authority", async () => {
    const f = fixture(),
      { code } = f.codes.issue();
    for (const body of [
      `{"\\u0063ode":"${code}"}`,
      `{"code":"\\u0063${code.slice(1)}"}`,
      `\u000b{"code":"${code}"}`,
      `{"code":"${code}",}`,
    ]) {
      const result = await f.app.request(`${ORIGIN}/auth/exchange-code`, {
        method: "POST",
        headers,
        body,
      });
      expect(result.status).toBe(400);
      expect(result.headers.get("cache-control")).toBe("no-store");
    }
    const compressed = await f.app.request(`${ORIGIN}/auth/exchange-code`, {
      method: "POST",
      headers: { ...headers, "content-encoding": "gzip" },
      body: JSON.stringify({ code }),
    });
    expect(compressed.status).toBe(415);
    expect((await f.exchange(code)).status).toBe(200);
  });
  it("uses the same redacted response for unknown, used and expired codes", async () => {
    let now = 1000;
    const codes = new InstallCodes(TOKEN, PORT, () => now);
    const app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog: {} as EventLog,
      installCodes: codes,
    });
    const used = codes.issue(),
      expired = codes.issue();
    codes.consume(used.code);
    now = expired.expiresAt;
    const bodies: string[] = [];
    for (const code of [used.code, expired.code, "z".repeat(43)]) {
      const result = await app.request(`${ORIGIN}/auth/exchange-code`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code }),
      });
      expect(result.status).toBe(401);
      bodies.push(await result.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });
  it("refuses issuance at capacity without evicting a pending link", async () => {
    const f = fixture(),
      first = f.codes.issue();
    for (let i = 1; i < 32; i++) f.codes.issue();
    const result = await f.app.request(`${ORIGIN}/api/install-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("60");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect((await f.exchange(first.code)).status).toBe(200);
  });
});

describe("install code exchange behind an HTTPS front", () => {
  const PUBLIC = "https://mac.tailnet.ts.net:4750";
  afterEach(() => setPublicOrigin(undefined));

  function exchangeVia(f: ReturnType<typeof fixture>, code: string, origin: string | undefined) {
    return f.app.request("http://mac.tailnet.ts.net:4750/auth/exchange-code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin === undefined ? {} : { origin }),
      },
      body: JSON.stringify({ code }),
    });
  }

  it("exchanges a code from exactly the configured public origin", async () => {
    setPublicOrigin(PUBLIC);
    const f = fixture();
    const reply = await exchangeVia(f, f.codes.issue().code, PUBLIC);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ token: TOKEN });
  });

  it("refuses that origin when no public origin is configured", async () => {
    const f = fixture();
    expect((await exchangeVia(f, f.codes.issue().code, PUBLIC)).status).toBe(403);
  });

  it("refuses a foreign or missing origin even with a public origin configured", async () => {
    setPublicOrigin(PUBLIC);
    const f = fixture();
    const issued = f.codes.issue();
    expect((await exchangeVia(f, issued.code, "https://evil.ts.net:4750")).status).toBe(403);
    expect((await exchangeVia(f, issued.code, `http://mac.tailnet.ts.net:4750`)).status).toBe(403);
    expect((await exchangeVia(f, issued.code, undefined)).status).toBe(403);
    expect((await exchangeVia(f, issued.code, PUBLIC)).status).toBe(200);
  });
});

it("lists only the local address and configured fronts, without issuing a credential", async () => {
  setPublicOrigin("https://computer.tail123.ts.net:4750,https://dot.example.test");
  try {
    const f = fixture();
    expect((await f.app.request(`${ORIGIN}/api/access-links`)).status).toBe(401);
    const result = await f.app.request(`${ORIGIN}/api/access-links`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(result.headers.get("cache-control")).toBe("no-store");
    const value = (await result.json()) as AccessLinksStatus;
    expect(value.links.map((link: { origin: string }) => link.origin)).toEqual([
      "http://localhost:4750",
      "https://computer.tail123.ts.net:4750",
      "https://dot.example.test",
    ]);
    expect(value.links[1]?.label).toBe("Tailscale");
    expect(value.tailscale.state).toBe("unavailable");
    expect(JSON.stringify(value)).not.toContain(TOKEN);
    expect(JSON.stringify(value)).not.toContain("#code");
  } finally {
    setPublicOrigin(undefined);
  }
});
