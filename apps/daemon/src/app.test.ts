import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const LOOPBACK = `127.0.0.1:${PORT}`;
const app = createApp({ token: TOKEN, port: PORT });
const url = (path: string, host = LOOPBACK) => `http://${host}${path}`;
const bearer = { authorization: `Bearer ${TOKEN}` };

describe("host and origin guard", () => {
  it("serves health on the loopback host", async () => {
    expect((await app.request(url("/healthz"))).status).toBe(200);
    expect((await app.request(url("/healthz", `localhost:${PORT}`))).status).toBe(200);
  });

  it("refuses rebinding hosts and hosts without the port", async () => {
    expect((await app.request(url("/healthz", "evil.com"))).status).toBe(403);
    expect((await app.request(url("/healthz", "127.0.0.1"))).status).toBe(403);
  });

  it("refuses a foreign Host header even when the URL host is loopback", async () => {
    const res = await app.request(url("/healthz"), { headers: { host: "evil.com" } });
    expect(res.status).toBe(403);
  });

  it("refuses foreign and null origins", async () => {
    const foreign = await app.request(url("/healthz"), { headers: { origin: "http://evil.com" } });
    const nullOrigin = await app.request(url("/healthz"), { headers: { origin: "null" } });
    expect(foreign.status).toBe(403);
    expect(nullOrigin.status).toBe(403);
  });

  const refusals: [string, string, Record<string, string>][] = [
    ["evil Host", "evil.com", {}],
    ["portless Host", "127.0.0.1", {}],
    ["null Origin", LOOPBACK, { origin: "null" }],
    ["wrong-port Origin", LOOPBACK, { origin: `http://127.0.0.1:${PORT + 1}` }],
  ];
  const paths = ["/healthz", "/api/whoami", "/does-not-exist"];

  it.each(
    refusals.flatMap(([label, host, headers]) =>
      paths.map((path) => [label, path, host, headers] as const),
    ),
  )("refuses %s on %s even with a valid bearer token", async (_label, path, host, headers) => {
    const res = await app.request(url(path, host), { headers: { host, ...bearer, ...headers } });
    expect(res.status).toBe(403);
  });
});

describe("token guard", () => {
  it("rejects API calls without the token", async () => {
    expect((await app.request(url("/api/whoami"))).status).toBe(401);
  });

  it("accepts the bearer token", async () => {
    const res = await app.request(url("/api/whoami"), { headers: bearer });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("ignores a session cookie even when it carries the right token", async () => {
    const res = await app.request(url("/api/whoami"), {
      headers: { cookie: `localdot_session=${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("has no cookie claim route", async () => {
    const res = await app.request(url(`/auth/claim?token=${TOKEN}`));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("never authenticates against an empty token", async () => {
    const emptyTokenApp = createApp({ token: "", port: PORT });
    const res = await emptyTokenApp.request(url("/api/whoami"), {
      headers: { authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });
});
