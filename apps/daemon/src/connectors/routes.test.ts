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

function setup(keys: KeydRecord[] = []) {
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
    keyd: { status: async () => ({ sealKey: "k" }) as never, putSecret: vi.fn() as never },
    fetchFor: async () => ({
      fetch: async () => new Response("", { status: 404 }),
      close: async () => {},
    }),
  });
  const routes = new Hono();
  connectorCallbackRoute(routes, signIn);
  connectorRoutes(routes, { hub, keyd, signIn, port: 4750 });
  const send = (method: string, path: string, body?: unknown) =>
    routes.request(path, {
      method,
      headers: { "content-type": "application/json", host: "127.0.0.1:4750" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { hub, send, deleted, app };
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
