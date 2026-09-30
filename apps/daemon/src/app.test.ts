import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const app = createApp({ token: TOKEN, port: PORT });
const url = (path: string, host = `127.0.0.1:${PORT}`) => `http://${host}${path}`;

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
});

describe("token guard", () => {
  it("rejects API calls without the token", async () => {
    expect((await app.request(url("/api/whoami"))).status).toBe(401);
  });

  it("accepts a bearer token or the session cookie", async () => {
    const bearer = await app.request(url("/api/whoami"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const cookie = await app.request(url("/api/whoami"), {
      headers: { cookie: `localdot_session=${TOKEN}` },
    });
    expect(bearer.status).toBe(200);
    expect(cookie.status).toBe(200);
  });

  it("claims a strict http-only session cookie with the right token only", async () => {
    expect((await app.request(url("/auth/claim?token=wrong"))).status).toBe(401);
    const ok = await app.request(url(`/auth/claim?token=${TOKEN}`));
    expect(ok.status).toBe(302);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("localdot_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("never authenticates against an empty token", async () => {
    const emptyTokenApp = createApp({ token: "", port: PORT });
    const cookie = await emptyTokenApp.request(url("/api/whoami"), {
      headers: { cookie: "localdot_session=" },
    });
    expect(cookie.status).toBe(401);
    expect((await emptyTokenApp.request(url("/auth/claim?token="))).status).toBe(401);
  });
});
