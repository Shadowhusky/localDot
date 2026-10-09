import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import type { CellSummary } from "../cells/types.ts";
import { type AccountsDeps, accountsRoutes, signInSites, siteOf } from "./accounts.ts";

const parent = "01JXYZ0000000000000000000A";
const endpoint = { parentCellId: parent, instance: "i-1" } as ReadyBrowser;

function fixture(state: CellSummary["state"] = "ready") {
  let domains = [
    { domain: ".google.com", count: 2 },
    { domain: "accounts.google.com", count: 3 },
    { domain: "web.telegram.org", count: 1 },
    { domain: "www.bbc.co.uk", count: 4 },
    { domain: "localhost", count: 1 },
    { domain: "10.0.0.5", count: 1 },
  ];
  const client = {
    cookieDomains: vi.fn(async () => domains),
    signOut: vi.fn(async (site: string) => {
      const before = domains.length;
      domains = domains.filter(
        ({ domain }) => !`.${domain.replace(/^\./u, "")}`.endsWith(`.${site}`),
      );
      return before - domains.length;
    }),
    close: vi.fn(),
  };
  const deps: AccountsDeps = {
    cells: { get: () => ({ id: parent, state }) as CellSummary },
    browser: {
      start: vi.fn(async () => endpoint),
      endpoints: () => endpoint,
      clearAccounts: vi.fn(async () => {}),
    },
    client: () => client,
  };
  const app = new Hono();
  accountsRoutes(app, deps);
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  return { app, deps, client, post };
}

describe("Settings > Accounts", () => {
  it("names each site by the domain people recognise", () => {
    expect(siteOf("accounts.google.com")).toBe("google.com");
    expect(siteOf("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("example.co")).toBe("example.co");
    expect(siteOf("web.telegram.org")).toBe("telegram.org");
  });

  it("lists the sites with stored sign-ins, grouped, without local names or addresses", async () => {
    const f = fixture();
    const reply = await f.app.request(`/api/cells/${parent}/accounts`);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({
      sites: [
        { site: "bbc.co.uk", hosts: ["www.bbc.co.uk"], cookies: 4 },
        { site: "google.com", hosts: ["accounts.google.com", "google.com"], cookies: 5 },
        { site: "telegram.org", hosts: ["web.telegram.org"], cookies: 1 },
      ],
    });
    expect(f.deps.browser.start).toHaveBeenCalledWith(parent, expect.any(AbortSignal));
    expect(f.client.close).toHaveBeenCalled();
  });

  it("signs out of a listed site only, and answers with what is left", async () => {
    const f = fixture();
    expect(
      (await f.post(`/api/cells/${parent}/accounts/sign-out`, { site: "x.test" })).status,
    ).toBe(404);
    expect((await f.post(`/api/cells/${parent}/accounts/sign-out`, { site: "../" })).status).toBe(
      400,
    );
    expect(f.client.signOut).not.toHaveBeenCalled();
    const reply = await f.post(`/api/cells/${parent}/accounts/sign-out`, { site: "google.com" });
    expect(f.client.signOut).toHaveBeenCalledWith("google.com", expect.any(Object));
    expect((await reply.json()) as unknown).toEqual({
      sites: [
        { site: "bbc.co.uk", hosts: ["www.bbc.co.uk"], cookies: 4 },
        { site: "telegram.org", hosts: ["web.telegram.org"], cookies: 1 },
      ],
    });
  });

  it("needs the computer on to read sign-ins, but can always clear them", async () => {
    const f = fixture("stopped");
    expect((await f.app.request(`/api/cells/${parent}/accounts`)).status).toBe(409);
    expect(f.deps.browser.start).not.toHaveBeenCalled();
    expect((await f.post("/api/accounts/clear")).status).toBe(200);
    expect(f.deps.browser.clearAccounts).toHaveBeenCalledOnce();
  });

  it("drops cookie names that are not site names", () => {
    expect(
      signInSites([
        { domain: "a..b", count: 1 },
        { domain: "-x.com", count: 1 },
        { domain: "Mail.Example.COM", count: 2 },
      ]),
    ).toEqual([{ site: "example.com", hosts: ["mail.example.com"], cookies: 2 }]);
  });
});
