import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-guest-")),
    owner = "o".repeat(43),
    port = 4750;
  const links = new RemoteLinks(home);
  cleanup.push(() => {
    links.close();
    rmSync(home, { recursive: true, force: true });
  });
  const token = links.create({
    label: "Guest",
    expiresInHours: null,
    maxTasks: 3,
    model: { provider: "openai", model: "gpt-6.1-sol" },
  }).token;
  const remote = {
    links,
    authenticate: (token?: string) => links.authenticate(token),
  } as unknown as RemoteAccess;
  const codes = new InstallCodes(owner, port);
  const app = createApp({
    token: owner,
    port,
    eventLog: new EventLog(home),
    remoteAccess: remote,
    installCodes: codes,
  });
  return { app, links, token, owner, codes, origin: `http://127.0.0.1:${port}` };
}
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
