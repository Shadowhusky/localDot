import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const LOOPBACK = `127.0.0.1:${PORT}`;
const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's app-")));
const app = createApp({ token: TOKEN, port: PORT, eventLog });
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
  const paths = ["/healthz", "/api/whoami", "/api/sessions", "/does-not-exist"];

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
    expect((await app.request(url("/api/sessions"))).status).toBe(401);
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
    const emptyTokenApp = createApp({ token: "", port: PORT, eventLog });
    const res = await emptyTokenApp.request(url("/api/whoami"), {
      headers: { authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });
});

describe("session routes", () => {
  it("lists sessions and returns a session's events", async () => {
    const id = eventLog.createSession("routes");
    eventLog.append(id, { type: "agent.state", agent: "main", data: { state: "idle" } });
    const list = (await (await app.request(url("/api/sessions"), { headers: bearer })).json()) as {
      id: string;
    }[];
    expect(list.map((s) => s.id)).toContain(id);
    const events = (await (
      await app.request(url(`/api/sessions/${id}/events`), { headers: bearer })
    ).json()) as unknown[];
    expect(events).toHaveLength(1);
    const later = (await (
      await app.request(url(`/api/sessions/${id}/events?fromSeq=1`), { headers: bearer })
    ).json()) as unknown[];
    expect(later).toEqual([]);
  });

  it("answers 404 for a well-formed id that names no session", async () => {
    const res = await app.request(url(`/api/sessions/${ulid()}/events`), { headers: bearer });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("unknown session");
  });

  it("answers 400 for a malformed session id", async () => {
    const res = await app.request(url("/api/sessions/not-a-ulid/events"), { headers: bearer });
    expect(res.status).toBe(400);
    const traversal = await app.request(url("/api/sessions/..%2F..%2Fetc/events"), {
      headers: bearer,
    });
    expect(traversal.status).toBe(400);
  });
});
