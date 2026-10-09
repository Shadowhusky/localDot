import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorHub } from "./hub.ts";
import { ConnectorSignIn } from "./oauth.ts";
import { ConnectorStore } from "./store.ts";
import { fakeApp } from "./testing/fake-app.ts";

const TOKEN = "notion_access_token_0123456789";
const AUTH = "https://auth.notion.example";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// An app's sign-in service, answering discovery, registration and the token exchange.
function signInService() {
  const requests: { url: string; body: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    requests.push({ url: url.href, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({ resource: "https://mcp.notion.example/mcp", authorization_servers: [AUTH] });
    if (url.origin === AUTH && url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/authorize`,
        token_endpoint: `${AUTH}/token`,
        registration_endpoint: `${AUTH}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.href === `${AUTH}/register`)
      return json({ ...JSON.parse(body), client_id: "client-1" }, 201);
    if (url.href === `${AUTH}/token`) return json({ access_token: TOKEN, token_type: "bearer" });
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-connector-oauth-"));
  homes.push(home);
  const store = new ConnectorStore(home);
  const hub = new ConnectorHub({ store, links: fakeApp([]).links, keys: async () => [] });
  const service = signInService();
  const put = vi.fn(async (binding: { id: string }) => ({
    id: binding.id,
    kind: "http" as const,
    createdAt: "t",
    updatedAt: "t",
  }));
  const sealed: string[] = [];
  const signIn = new ConnectorSignIn({
    hub,
    keyd: { status: async () => ({ sealKey: "k" }) as never, putSecret: put as never },
    fetchFor: async () => ({ fetch: service.fetch, close: async () => {} }),
    seal: async (_key, _binding, value) => {
      sealed.push(value);
      return { v: 1, epk: "e".repeat(87), nonce: "n".repeat(16), ct: "c".repeat(64) };
    },
  });
  const { id } = hub.add({
    name: "Notion",
    server: {
      kind: "remote",
      url: "https://mcp.notion.example/mcp",
      transport: "http",
      auth: { kind: "oauth" },
    },
  });
  return { home, store, hub, signIn, service, put, sealed, id };
}

describe("ConnectorSignIn", () => {
  it("signs in with PKCE and keeps the token in keyd only, bound to the app's host", async () => {
    const { home, store, signIn, service, put, sealed, id } = setup();
    const page = new URL(await signIn.start(id, "http://127.0.0.1:4750"));
    expect(page.origin + page.pathname).toBe(`${AUTH}/authorize`);
    expect(page.searchParams.get("client_id")).toBe("client-1");
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(page.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4750/connectors/callback");
    const state = page.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(await signIn.finish(state, "code-1")).toBe("Notion");
    const exchange = service.requests.find((r) => r.url === `${AUTH}/token`);
    expect(exchange?.body).toContain("code_verifier=");
    expect(sealed).toEqual([TOKEN]);
    expect(put).toHaveBeenCalledWith(
      {
        id: "connector-notion",
        kind: "http",
        hosts: ["mcp.notion.example"],
        header: "authorization",
        format: "bearer",
      },
      expect.anything(),
    );
    expect(store.list()[0]?.server).toMatchObject({
      auth: { kind: "oauth", secret: "connector-notion" },
    });
    expect(store.list()[0]?.client).toEqual({
      clientId: "client-1",
      redirectUri: "http://127.0.0.1:4750/connectors/callback",
    });
    expect(readFileSync(join(home, "connectors.json"), "utf8")).not.toContain(TOKEN);
  });

  it("takes each sign-in back once, and none it didn't start", async () => {
    const { signIn, id } = setup();
    const state = new URL(await signIn.start(id, "http://127.0.0.1:4750")).searchParams.get(
      "state",
    );
    await expect(signIn.finish("made-up", "code")).rejects.toMatchObject({ status: "failed" });
    await signIn.finish(state ?? "", "code");
    await expect(signIn.finish(state ?? "", "code")).rejects.toThrow("expired");
  });

  it("signs in only an app set up to sign in", async () => {
    const { signIn, hub } = setup();
    const other = hub.add({
      name: "Docs",
      server: {
        kind: "remote",
        url: "https://mcp.deepwiki.com/mcp",
        transport: "http",
        auth: { kind: "none" },
      },
    });
    await expect(signIn.start(other.id, "http://127.0.0.1:4750")).rejects.toThrow(
      "doesn't sign in",
    );
  });
});
