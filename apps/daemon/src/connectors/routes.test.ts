import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeydRecord } from "@localdot/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorHub } from "./hub.ts";
import { ConnectorSignIn } from "./oauth.ts";
import { connectorCallbackRoute, connectorRoutes } from "./routes.ts";
import { ConnectorStore } from "./store.ts";
import { fakeApp } from "./testing/fake-app.ts";

const homes: string[] = [];
const hubs: ConnectorHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const key = (id: string, hosts: string[]): KeydRecord => ({
  id,
  kind: "http",
  hosts,
  header: "authorization",
  format: "bearer",
  createdAt: "t",
  updatedAt: "t",
});

const signedInKey = (id: string, oauth: KeydRecord["oauth"]): KeydRecord => ({
  ...key(id, ["mcp.linear.app"]),
  oauth,
});

const linearApp = {
  name: "Linear",
  catalog: "linear",
  server: {
    kind: "remote",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    auth: { kind: "oauth" },
  },
};

const signInStub = (signIn: ConnectorSignIn, opened = true) => {
  const start = vi
    .spyOn(signIn, "start")
    .mockImplementation(async (_id, _origin, _remote) => ({ opened, expiresAt: 42 }));
  return start;
};

function setup(keys: KeydRecord[] = [], remote?: (host: string | undefined) => boolean) {
  const home = mkdtempSync(join(tmpdir(), "localdot-connector-routes-"));
  homes.push(home);
  const app = fakeApp([{ name: "list_issues" }, { name: "create_issue" }]);
  const hub = new ConnectorHub({
    store: new ConnectorStore(home),
    links: app.links,
    keys: async () => keys,
  });
  hubs.push(hub);
  const deleted = vi.fn(async (_id: string) => true);
  const keyd = { secrets: async () => keys, deleteSecret: deleted };
  const signIn = new ConnectorSignIn({
    hub,
    keyd: { status: async () => ({ oauth: true }) as never, connectOAuth: vi.fn() as never },
    fetchFor: async () => ({
      fetch: async () => new Response("", { status: 404 }),
      close: async () => {},
    }),
    open: async () => true,
  });
  const routes = new Hono();
  connectorCallbackRoute(routes, signIn);
  connectorRoutes(routes, { hub, keyd, signIn, port: 4750, ...(remote ? { remote } : {}) });
  const send = (method: string, path: string, body?: unknown, host = "127.0.0.1:4750") =>
    routes.request(path, {
      method,
      headers: { "content-type": "application/json", host },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { hub, send, deleted, app, signIn };
}

const github = (secret: string) => ({
  name: "GitHub",
  catalog: "github",
  server: {
    kind: "remote",
    url: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    auth: { kind: "key", secret },
  },
});

describe("connector routes", () => {
  it("lists the user's apps with the catalogue", async () => {
    const { send } = setup();
    const body = (await (await send("GET", "/api/connectors")).json()) as {
      connectors: unknown[];
      catalog: { id: string }[];
    };
    expect(body.connectors).toEqual([]);
    expect(body.catalog.map((entry) => entry.id)).toContain("github");
  });

  it("adds an app only with a key bound to its own host, then lists its tools", async () => {
    const { send, hub } = setup([
      key("connector-github", ["api.githubcopilot.com"]),
      key("weather", ["api.weather.example"]),
    ]);
    const wrong = await send("POST", "/api/connectors", github("weather"));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "needs_key" });
    const missing = await send("POST", "/api/connectors", github("connector-nothing"));
    expect(missing.status).toBe(400);
    const plain = await send("POST", "/api/connectors", {
      name: "Box",
      server: {
        kind: "remote",
        url: "http://box.example/mcp",
        transport: "http",
        auth: { kind: "none" },
      },
    });
    expect(plain.status).toBe(400);
    expect(await plain.json()).toMatchObject({ message: "Use an https:// address." });
    const added = await send("POST", "/api/connectors", github("connector-github"));
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ connector: { id: "github", name: "GitHub" } });
    await vi.waitFor(async () => expect((await hub.view("github"))?.status).toBe("ready"));
    expect((await hub.view("github"))?.tools.map((t) => t.name)).toEqual([
      "list_issues",
      "create_issue",
    ]);
  });

  it("saves the user's choices per tool and removes an app with its own keys only", async () => {
    const { send, deleted } = setup([key("connector-github", ["api.githubcopilot.com"])]);
    await send("POST", "/api/connectors", github("connector-github"));
    const patched = await send("PUT", "/api/connectors/github", {
      enabled: false,
      tools: { create_issue: { enabled: false, access: "read" } },
    });
    expect(await patched.json()).toMatchObject({ connector: { enabled: false, status: "off" } });
    expect(
      (await send("PUT", "/api/connectors/github", { tools: { x: { mode: 1 } } })).status,
    ).toBe(400);
    expect((await send("DELETE", "/api/connectors/nope")).status).toBe(404);
    expect((await send("DELETE", "/api/connectors/github")).status).toBe(204);
    expect(deleted.mock.calls).toEqual([["connector-github"]]);
  });

  it("always comes back to loopback, and tells another device it can only wait", async () => {
    const { send, signIn, hub } = setup();
    const start = signInStub(signIn);
    await send("POST", "/api/connectors", linearApp);
    const local = await send("POST", "/api/connectors/linear/sign-in");
    expect(await local.json()).toEqual({ opened: true, expiresAt: 42, remote: false });
    expect(start).toHaveBeenLastCalledWith("linear", "http://127.0.0.1:4750", false);
    const fromPhone = await send(
      "POST",
      "/api/connectors/linear/sign-in",
      undefined,
      "phone.example.ts.net",
    );
    expect(await fromPhone.json()).toMatchObject({ remote: true });
    expect(start).toHaveBeenLastCalledWith("linear", "http://127.0.0.1:4750", true);
    expect((await send("POST", "/api/connectors/nope/sign-in")).status).toBe(404);
    expect((await hub.view("linear"))?.status).toBe("needs_sign_in");
  });

  it("cancels an open sign-in", async () => {
    const { send, hub } = setup();
    await send("POST", "/api/connectors", linearApp);
    hub.setSignIn("linear", { expiresAt: Date.now() + 60_000, remote: false });
    expect((await hub.view("linear"))?.signIn).toBeDefined();
    const cancelled = await send("DELETE", "/api/connectors/linear/sign-in");
    expect(cancelled.status).toBe(200);
    expect((await hub.view("linear"))?.signIn).toBeUndefined();
  });

  it("disconnects by ending the sign-in and keeps the app and its choices", async () => {
    const keys = [
      signedInKey("connector-linear", { refreshes: true, account: "ada@example.test" }),
    ];
    const { send, hub, deleted } = setup(keys);
    await send("POST", "/api/connectors", {
      ...linearApp,
      server: { ...linearApp.server, auth: { kind: "oauth", secret: "connector-linear" } },
    });
    await hub.update("linear", { tools: { create_issue: { enabled: false } } });
    await vi.waitFor(async () => expect((await hub.view("linear"))?.status).toBe("ready"));
    expect((await hub.view("linear"))?.account).toBe("ada@example.test");
    const gone = await send("POST", "/api/connectors/linear/disconnect");
    expect(gone.status).toBe(200);
    expect(deleted.mock.calls).toEqual([["connector-linear"]]);
    const view = (await gone.json()) as { connector: { status: string; server: unknown } };
    expect(view.connector.status).toBe("needs_sign_in");
    expect(view.connector.server).toMatchObject({ auth: { kind: "oauth" } });
    expect(hub.config("linear")?.tools).toEqual({ create_issue: { enabled: false } });
    expect(hub.forTask().specs).toEqual([]);
  });

  it("disconnects only an app that signs in", async () => {
    const { send } = setup([key("connector-github", ["api.githubcopilot.com"])]);
    await send("POST", "/api/connectors", github("connector-github"));
    expect((await send("POST", "/api/connectors/github/disconnect")).status).toBe(400);
  });

  it("asks to reconnect once keyd says a sign-in has ended", async () => {
    const keys = [signedInKey("connector-linear", { refreshes: true, reconnect: true })];
    const { send, hub } = setup(keys);
    await send("POST", "/api/connectors", {
      ...linearApp,
      server: { ...linearApp.server, auth: { kind: "oauth", secret: "connector-linear" } },
    });
    const view = await hub.view("linear");
    expect(view?.status).toBe("needs_sign_in");
    expect(view?.problem).toContain("Reconnect");
  });

  it("records an app's refusal when it sends the user back", async () => {
    const { send, signIn } = setup();
    const declined = vi.spyOn(signIn, "declined");
    const page = await send(
      "GET",
      "/connectors/callback?state=abc&error=access_denied&iss=https%3A%2F%2Fauth.example",
    );
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("Not connected");
    expect(declined).toHaveBeenCalledWith("abc", "https://auth.example");
  });

  it("passes the service's name for itself along to be checked", async () => {
    const { send, signIn } = setup();
    const finish = vi.spyOn(signIn, "finish").mockResolvedValue("Linear");
    const page = await send(
      "GET",
      "/connectors/callback?state=abc&code=x&iss=https%3A%2F%2Fa.example",
    );
    expect(await page.text()).toContain("Connected to Linear");
    expect(finish).toHaveBeenCalledWith("abc", "x", "https://a.example");
  });

  it("refuses a sign-in callback it didn't start, without the install token", async () => {
    const { send } = setup();
    const none = await send("GET", "/connectors/callback");
    expect(none.status).toBe(400);
    expect(none.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    const forged = await send("GET", "/connectors/callback?state=abc&code=x");
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain("This sign-in has expired");
  });
});
