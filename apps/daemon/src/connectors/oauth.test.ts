import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_METADATA_URL, type KeydOAuthGrant } from "@localdot/protocol";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeydError } from "../keyd/client.ts";
import { ConnectorHub } from "./hub.ts";
import { ConnectorSignIn } from "./oauth.ts";
import { ConnectorStore } from "./store.ts";
import { fakeApp } from "./testing/fake-app.ts";

const AUTH = "https://auth.notion.example";
const RESOURCE = "https://mcp.notion.example/mcp";
const ORIGIN = "http://127.0.0.1:4750";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

interface ServiceOptions {
  cimd?: boolean;
  registers?: boolean;
  scopes?: string[];
  metadataScopes?: string[];
  challengeScope?: string;
  issuerSaid?: boolean;
  noPkce?: boolean;
}

// An app and its sign-in service, answering the unsigned request, discovery and registration.
function signInService(options: ServiceOptions = {}) {
  const requests: { url: string; method: string; body: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    requests.push({ url: url.href, method: init?.method ?? "GET", body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.href === RESOURCE && init?.method === "POST")
      return new Response("", {
        status: 401,
        headers: options.challengeScope
          ? { "www-authenticate": `Bearer scope="${options.challengeScope}"` }
          : {},
      });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: RESOURCE,
        authorization_servers: [AUTH],
        ...(options.scopes ? { scopes_supported: options.scopes } : {}),
      });
    if (url.origin === AUTH && url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/authorize`,
        token_endpoint: `${AUTH}/token`,
        revocation_endpoint: `${AUTH}/revoke`,
        ...(options.registers === false ? {} : { registration_endpoint: `${AUTH}/register` }),
        ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
        ...(options.metadataScopes ? { scopes_supported: options.metadataScopes } : {}),
        ...(options.issuerSaid ? { authorization_response_iss_parameter_supported: true } : {}),
        response_types_supported: ["code"],
        ...(options.noPkce ? {} : { code_challenge_methods_supported: ["S256"] }),
      });
    if (url.href === `${AUTH}/register`)
      return json({ ...JSON.parse(body), client_id: "client-1" }, 201);
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests };
}

function setup(options: ServiceOptions = {}, status = { oauth: true }) {
  const home = mkdtempSync(join(tmpdir(), "localdot-connector-oauth-"));
  homes.push(home);
  const store = new ConnectorStore(home);
  const hub = new ConnectorHub({ store, links: fakeApp([]).links, keys: async () => [] });
  const service = signInService(options);
  const connectOAuth = vi.fn(async (binding: { id: string }, _grant: KeydOAuthGrant) => ({
    id: binding.id,
    kind: "http" as const,
    createdAt: "t",
    updatedAt: "t",
  }));
  const open = vi.fn(async (_url: string) => true);
  const fetchFor = vi.fn(async (_id: string, _secret?: string) => ({
    fetch: service.fetch,
    close: async () => {},
  }));
  const signIn = new ConnectorSignIn({
    hub,
    keyd: { status: async () => status as never, connectOAuth: connectOAuth as never },
    fetchFor,
    open,
  });
  const { id } = hub.add({
    name: "Notion",
    server: { kind: "remote", url: RESOURCE, transport: "http", auth: { kind: "oauth" } },
  });
  const page = () => new URL(String(open.mock.lastCall?.[0]));
  return { home, store, hub, signIn, service, connectOAuth, open, fetchFor, id, page };
}

describe("ConnectorSignIn", () => {
  it("opens the page in this computer's browser and leaves the tokens to keyd", async () => {
    const { home, store, signIn, service, connectOAuth, id, page } = setup({ cimd: true });
    const started = await signIn.start(id, ORIGIN, false);
    expect(started.opened).toBe(true);
    expect(started.url).toBeUndefined();
    const at = page();
    expect(at.origin + at.pathname).toBe(`${AUTH}/authorize`);
    expect(at.searchParams.get("code_challenge_method")).toBe("S256");
    expect(at.searchParams.get("resource")).toBe(RESOURCE);
    expect(at.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/connectors/callback`);
    const state = at.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(await signIn.finish(state, "code-1")).toBe("Notion");
    expect(service.requests.some((r) => r.url === `${AUTH}/token`)).toBe(false);
    expect(connectOAuth).toHaveBeenCalledOnce();
    const [binding, grant] = connectOAuth.mock.lastCall ?? [];
    expect(binding).toEqual({
      id: "connector-notion",
      kind: "http",
      hosts: ["mcp.notion.example"],
      header: "authorization",
      format: "bearer",
    });
    expect(grant).toMatchObject({
      tokenEndpoint: `${AUTH}/token`,
      revocationEndpoint: `${AUTH}/revoke`,
      clientId: CLIENT_METADATA_URL,
      authMethod: "none",
      resource: RESOURCE,
      code: "code-1",
      redirectUri: `${ORIGIN}/connectors/callback`,
    });
    expect(grant?.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(store.list()[0]?.server).toMatchObject({
      auth: { kind: "oauth", secret: "connector-notion" },
    });
    expect(readFileSync(join(home, "connectors.json"), "utf8")).not.toContain("code-1");
  });

  it("uses the public document where the service reads one, with no registration", async () => {
    const { signIn, service, id, page, store } = setup({ cimd: true });
    await signIn.start(id, ORIGIN, false);
    expect(page().searchParams.get("client_id")).toBe(CLIENT_METADATA_URL);
    expect(service.requests.some((r) => r.url === `${AUTH}/register`)).toBe(false);
    expect(store.list()[0]?.client).toBeUndefined();
  });

  it("registers itself, asking to refresh, where the service has no document support", async () => {
    const { signIn, service, id, page, store } = setup();
    await signIn.start(id, ORIGIN, false);
    expect(page().searchParams.get("client_id")).toBe("client-1");
    const asked = JSON.parse(
      service.requests.find((r) => r.url === `${AUTH}/register`)?.body ?? "",
    );
    expect(asked).toMatchObject({
      client_name: "localDot",
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      redirect_uris: [`${ORIGIN}/connectors/callback`],
    });
    expect(store.list()[0]?.client).toEqual({
      clientId: "client-1",
      redirectUri: `${ORIGIN}/connectors/callback`,
      issuer: AUTH,
    });
    await signIn.start(id, ORIGIN, false);
    expect(service.requests.filter((r) => r.url === `${AUTH}/register`)).toHaveLength(1);
  });

  it("registers again when its registration is from before it asked to refresh", async () => {
    const { signIn, service, id, hub, page } = setup();
    hub.setClient(id, { clientId: "old-client", redirectUri: `${ORIGIN}/connectors/callback` });
    await signIn.start(id, ORIGIN, false);
    expect(service.requests.some((r) => r.url === `${AUTH}/register`)).toBe(true);
    expect(page().searchParams.get("client_id")).toBe("client-1");
  });

  it("says plainly when an app won't let it register", async () => {
    const { hub, id, service, open } = setup();
    const refusing: FetchLike = async (input, init) =>
      String(input) === `${AUTH}/register`
        ? new Response(JSON.stringify({ error: "access_denied" }), { status: 403 })
        : service.fetch(input, init);
    const strict = new ConnectorSignIn({
      hub,
      keyd: { status: async () => ({ oauth: true }) as never, connectOAuth: vi.fn() as never },
      fetchFor: async () => ({ fetch: refusing, close: async () => {} }),
      open,
    });
    await expect(strict.start(id, ORIGIN, false)).rejects.toThrow("didn't let localDot register");
    expect(open).not.toHaveBeenCalled();
  });

  it("drops a sign-in for an app removed meanwhile, storing nothing", async () => {
    const { signIn, id, hub, page, connectOAuth } = setup({ cimd: true });
    await signIn.start(id, ORIGIN, false);
    const state = page().searchParams.get("state") ?? "";
    await hub.remove(id);
    await expect(signIn.finish(state, "code")).rejects.toThrow("expired");
    expect(connectOAuth).not.toHaveBeenCalled();
  });

  it("says plainly when an app needs a registered client", async () => {
    const { signIn, id, open } = setup({ registers: false });
    await expect(signIn.start(id, ORIGIN, false)).rejects.toThrow("registered with it");
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a service that doesn't offer PKCE", async () => {
    const { signIn, id, open } = setup({ noPkce: true });
    await expect(signIn.start(id, ORIGIN, false)).rejects.toThrow("isn't one localDot can use");
    expect(open).not.toHaveBeenCalled();
  });

  it("asks for what the app challenged for, and offline access only where it is named", async () => {
    const challenged = setup({ cimd: true, scopes: ["a", "b"], challengeScope: "a" });
    await challenged.signIn.start(challenged.id, ORIGIN, false);
    expect(challenged.page().searchParams.get("scope")).toBe("a");

    const listed = setup({ cimd: true, scopes: ["a", "b"] });
    await listed.signIn.start(listed.id, ORIGIN, false);
    expect(listed.page().searchParams.get("scope")).toBe("a b");

    const offline = setup({ cimd: true, scopes: ["a"], metadataScopes: ["a", "offline_access"] });
    await offline.signIn.start(offline.id, ORIGIN, false);
    expect(offline.page().searchParams.get("scope")).toBe("a offline_access");
    expect(offline.page().searchParams.get("prompt")).toBe("consent");

    const none = setup({ cimd: true });
    await none.signIn.start(none.id, ORIGIN, false);
    expect(none.page().searchParams.has("scope")).toBe(false);
  });

  it("gives a local browser the page's address if it couldn't be opened", async () => {
    const { signIn, id, open, hub } = setup({ cimd: true });
    open.mockResolvedValue(false);
    const started = await signIn.start(id, ORIGIN, false);
    expect(started.opened).toBe(false);
    expect(started.url).toContain(`${AUTH}/authorize`);
    expect((await hub.view(id))?.signIn?.remote).toBe(false);
  });

  it("tells another device when no browser could be opened, rather than waiting", async () => {
    const { signIn, id, open, hub } = setup({ cimd: true });
    open.mockResolvedValue(false);
    await expect(signIn.start(id, ORIGIN, true)).rejects.toThrow("can't be finished from here");
    expect((await hub.view(id))?.signIn).toBeUndefined();
  });

  it("shows a wait until the sign-in finishes, is cancelled or runs out of time", async () => {
    let now = 1_000_000;
    const { hub, service, id } = setup({ cimd: true });
    const signIn = new ConnectorSignIn({
      hub,
      keyd: {
        status: async () => ({ oauth: true }) as never,
        connectOAuth: (async () => ({})) as never,
      },
      fetchFor: async () => ({ fetch: service.fetch, close: async () => {} }),
      open: async () => true,
      now: () => now,
    });
    const hubNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { expiresAt } = await signIn.start(id, ORIGIN, true);
      expect((await hub.view(id))?.signIn).toEqual({ expiresAt, remote: true });
      signIn.cancel(id);
      expect((await hub.view(id))?.signIn).toBeUndefined();
      await signIn.start(id, ORIGIN, true);
      now += 11 * 60_000;
      const view = await hub.view(id);
      expect(view?.signIn).toBeUndefined();
      expect(view?.problem).toContain("ran out of time");
    } finally {
      hubNow.mockRestore();
    }
  });

  it("takes each sign-in back once, and none it didn't start", async () => {
    const { signIn, id, page } = setup({ cimd: true });
    await signIn.start(id, ORIGIN, false);
    const state = page().searchParams.get("state") ?? "";
    await expect(signIn.finish("made-up", "code")).rejects.toMatchObject({ status: "failed" });
    await signIn.finish(state, "code");
    await expect(signIn.finish(state, "code")).rejects.toThrow("expired");
  });

  it("replaces a sign-in already open for the app", async () => {
    const { signIn, id, page } = setup({ cimd: true });
    await signIn.start(id, ORIGIN, false);
    const first = page().searchParams.get("state") ?? "";
    await signIn.start(id, ORIGIN, false);
    await expect(signIn.finish(first, "code")).rejects.toThrow("expired");
  });

  it("reads an answer only from the service the sign-in went to", async () => {
    const said = setup({ cimd: true, issuerSaid: true });
    await said.signIn.start(said.id, ORIGIN, false);
    const state = said.page().searchParams.get("state") ?? "";
    await expect(said.signIn.finish(state, "code")).rejects.toThrow("wrong place");
    await expect(said.signIn.finish(state, "code", "https://evil.example")).rejects.toThrow(
      "wrong place",
    );
    said.signIn.declined(state, "https://evil.example");
    expect((await said.hub.view(said.id))?.signIn).toBeDefined();
    expect(await said.signIn.finish(state, "code", AUTH)).toBe("Notion");

    const silent = setup({ cimd: true });
    await silent.signIn.start(silent.id, ORIGIN, false);
    const other = silent.page().searchParams.get("state") ?? "";
    await expect(silent.signIn.finish(other, "code", "https://evil.example")).rejects.toThrow(
      "wrong place",
    );
  });

  it("says why a sign-in didn't finish, and leaves it to be tried again", async () => {
    const { signIn, id, page, hub, connectOAuth } = setup({ cimd: true });
    await signIn.start(id, ORIGIN, false);
    signIn.declined(page().searchParams.get("state") ?? "", undefined);
    let view = await hub.view(id);
    expect(view?.signIn).toBeUndefined();
    expect(view?.problem).toContain("wasn't approved");

    await signIn.start(id, ORIGIN, false);
    connectOAuth.mockRejectedValueOnce(new KeydError(502, "oauth-refused", "invalid_grant", "/x"));
    await expect(signIn.finish(page().searchParams.get("state") ?? "", "code")).rejects.toThrow(
      "didn't accept",
    );
    view = await hub.view(id);
    expect(view?.problem).toContain("didn't accept");
    expect(view?.server).toMatchObject({ auth: { kind: "oauth" } });
    expect(view?.server).not.toMatchObject({ auth: { secret: expect.anything() } });
  });

  it("reaches an app signing in again through a listener that holds its key", async () => {
    const { signIn, id, hub, fetchFor, service } = setup({ cimd: true });
    await hub.update(id, {
      server: {
        kind: "remote",
        url: RESOURCE,
        transport: "http",
        auth: { kind: "oauth", secret: "connector-notion" },
      },
    });
    await signIn.start(id, ORIGIN, false);
    expect(fetchFor).toHaveBeenCalledWith(id, "connector-notion");
    expect(service.requests[0]).toMatchObject({ url: RESOURCE, method: "POST" });
  });

  it("says so when keyd doesn't answer, and shows no wait for a sign-in that failed to start", async () => {
    const { hub, id, service, open } = setup({ noPkce: true });
    hub.setSignIn(id, { expiresAt: Date.now() + 60_000, remote: false });
    const silent = new ConnectorSignIn({
      hub,
      keyd: {
        status: async () => {
          throw new Error("no socket");
        },
        connectOAuth: vi.fn() as never,
      },
      fetchFor: async () => ({ fetch: service.fetch, close: async () => {} }),
      open,
    });
    await expect(silent.start(id, ORIGIN, false)).rejects.toThrow("key service didn't answer");
    const failing = new ConnectorSignIn({
      hub,
      keyd: { status: async () => ({ oauth: true }) as never, connectOAuth: vi.fn() as never },
      fetchFor: async () => ({ fetch: service.fetch, close: async () => {} }),
      open,
    });
    await expect(failing.start(id, ORIGIN, false)).rejects.toThrow("isn't one localDot can use");
    expect((await hub.view(id))?.signIn).toBeUndefined();
  });

  it("asks for an updated keyd rather than failing strangely", async () => {
    const { signIn, id, open } = setup({ cimd: true }, { oauth: false });
    await expect(signIn.start(id, ORIGIN, false)).rejects.toThrow("needs an update");
    expect(open).not.toHaveBeenCalled();
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
    await expect(signIn.start(other.id, ORIGIN, false)).rejects.toThrow("doesn't sign in");
  });
});
