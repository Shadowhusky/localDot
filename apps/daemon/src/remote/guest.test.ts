import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { InstallCodes } from "../install-codes.ts";
import { RemoteLinks } from "./links.ts";
import type { RemoteAccess } from "./manager.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture(replay = false) {
  const home = mkdtempSync(join(tmpdir(), "localdot-guest-")),
    owner = "o".repeat(43),
    port = 4750;
  const links = new RemoteLinks(home);
  const eventLog = new EventLog(home);
  cleanup.push(() => {
    links.close();
    eventLog.close();
    rmSync(home, { recursive: true, force: true });
  });
  const { token, grant } = links.create({
    label: "Guest",
    expiresInHours: null,
    maxTasks: 3,
    replay,
    model: { provider: "openai", model: "gpt-6.1-sol" },
  });
  const remote = {
    links,
    authenticate: (token?: string) => links.authenticate(token),
  } as unknown as RemoteAccess;
  const codes = new InstallCodes(owner, port);
  const app = createApp({
    token: owner,
    port,
    eventLog,
    remoteAccess: remote,
    installCodes: codes,
  });
  return { app, links, grant, token, owner, codes, eventLog, origin: `http://127.0.0.1:${port}` };
}
function task(eventLog: EventLog, text: string) {
  const id = eventLog.createSession(text);
  eventLog.append(id, {
    type: "message.user",
    agent: "main",
    data: { messageId: ulid(), text, kind: "task" },
  });
  return id;
}
const NDJSON = { accept: "application/x-ndjson" };
it("gives a link none of the owner's tasks it did not start, whatever the route", async () => {
  const { app, links, grant, token, owner, eventLog, origin } = fixture();
  const theirs = task(eventLog, "The owner's private task");
  const own = task(eventLog, "The guest's task");
  links.reserve(grant.id).finish(own);
  const read = (path: string, bearer: string, headers: Record<string, string> = {}) =>
    app.request(`${origin}${path}`, { headers: { authorization: `Bearer ${bearer}`, ...headers } });
  for (const [path, headers] of [
    [`/api/sessions/${theirs}/events`, {}],
    [`/api/sessions/${theirs}/events?fromSeq=0`, NDJSON],
    [`/api/sessions/${theirs}/history`, {}],
    [`/api/sessions/${theirs}/clock`, {}],
    [`/api/agent/sessions/${theirs}`, {}],
    [`/api/sessions/${theirs}/card`, {}],
    [`/api/sessions/${theirs}/recording`, {}],
    ["/api/sessions", {}],
    ["/api/session-index", {}],
    ["/api/conversations", {}],
    ["/api/conversations?archived=1", {}],
  ] as const) {
    const reply = await read(path, token, headers);
    expect(reply.status, path).toBe(403);
    expect(await reply.text(), path).not.toContain("private task");
  }
  for (const path of [`/api/sessions/${theirs}/events`, `/api/sessions/${theirs}/history`])
    expect((await read(path, owner)).status, path).toBe(200);
  const events = await read(`/api/sessions/${own}/events`, token);
  expect(events.status).toBe(200);
  expect(await events.text()).toContain("The guest's task");
  const history = await read(`/api/sessions/${own}/history`, token);
  expect(history.status).toBe(200);
  expect(await history.text()).toContain("The guest's task");
});
it("opens every task's recordings to a link with Replay, but never another's live feed", async () => {
  const { app, token, eventLog, origin } = fixture(true);
  const theirs = task(eventLog, "The owner's task");
  const read = (path: string) =>
    app.request(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect((await read(`/api/sessions/${theirs}/events`)).status).toBe(200);
  expect((await read(`/api/sessions/${theirs}/history`)).status).toBe(200);
  expect((await read(`/api/sessions/${theirs}/clock`)).status).toBe(403);
  expect((await read(`/api/agent/sessions/${theirs}`)).status).toBe(403);
  expect((await read("/api/conversations")).status).toBe(403);
});
it("guest exchange retains its own restricted token; owner exchange stays single use", async () => {
  const { app, token, owner, codes, origin } = fixture();
  const exchange = (code: string) =>
    app.request(`${origin}/auth/exchange-code`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  const guest = await exchange(token);
  expect(guest.status).toBe(200);
  expect(await guest.json()).toEqual({ token });
  const code = codes.issue().code;
  expect(await (await exchange(code)).json()).toEqual({ token: owner });
  expect((await exchange(code)).status).toBe(401);
  const who = await app.request(`${origin}/api/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await who.json()).toEqual({ ok: true, shared: true });
  expect(
    (
      await app.request(`${origin}/api/agent/settings`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(403);
});
it("guest exchange uses the same origin, body and content-type defenses as owner exchange", async () => {
  const { app, token, origin } = fixture();
  for (const headers of [
    { "content-type": "application/json" },
    { origin, "content-type": "text/plain" },
    { origin: "https://evil.example", "content-type": "application/json" },
  ]) {
    expect(
      (
        await app.request(`${origin}/auth/exchange-code`, {
          method: "POST",
          headers,
          body: JSON.stringify({ code: token }),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect(
    (
      await app.request(`${origin}/auth/exchange-code`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ code: token, padding: "x".repeat(1000) }),
      })
    ).status,
  ).toBe(413);
});
it("revocation immediately rejects an already exchanged bearer", async () => {
  const { app, token, links, origin } = fixture();
  links.revoke(links.authenticate(token)!.id);
  expect(
    (await app.request(`${origin}/api/whoami`, { headers: { authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(401);
});
