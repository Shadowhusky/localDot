import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KeydClient, keydSocketPath } from "../keyd/client.ts";
import { KEYD_TESTS, startKeyd, TEST_KEYD_PORTS } from "../keyd/testing/keyd-process.ts";
import { ConnectorHub, type TaskConnectorTool } from "./hub.ts";
import { CellAndRemoteLinks } from "./links.ts";
import { ConnectorSignIn } from "./oauth.ts";
import { RemoteLinks } from "./remote.ts";
import { ConnectorStore } from "./store.ts";

const KEYD_DIR = fileURLToPath(new URL("../../../../keyd/", import.meta.url));
const APP = "https://mcp.fake-app.example.test/mcp";
const AUTH = "https://auth.fake-app.example.test";
// keyd/internal/oauthfixture's access tokens end after this long, and are refreshed a quarter before.
const LIFETIME_S = 3;

interface AppState {
  refreshes: number;
  refused: number;
  calls: string[] | null;
  issued: number;
  revoked: boolean;
}

// keyd's own binary: the daemon's requests must be what keyd's strict decoding takes.
describe.skipIf(!KEYD_TESTS)("connecting an app, against the real keyd", () => {
  it("says it redeems sign-ins, and refuses a token endpoint it won't reach without dialling", async () => {
    const keyd = await startKeyd();
    try {
      const client = new KeydClient(keyd.socketPath);
      expect((await client.status()).oauth).toBe(true);
      await expect(
        client.connectOAuth(
          {
            id: "connector-app",
            hosts: ["mcp.fake-app.example.test"],
            header: "authorization",
            format: "bearer",
          },
          {
            tokenEndpoint: "https://127.0.0.1/token",
            revocationEndpoint: "https://auth.example.test/revoke",
            clientId: "https://localdot.dev/oauth/client-metadata.json",
            authMethod: "none",
            resource: APP,
            code: "the-code",
            codeVerifier: "v".repeat(43),
            redirectUri: "http://127.0.0.1:4750/connectors/callback",
          },
        ),
      ).rejects.toMatchObject({ status: 400, detail: expect.stringContaining("token endpoint") });
      expect(await client.secrets()).toEqual([]);
      expect(await client.renewOAuth("connector-app")).toBe("reconnect");
    } finally {
      await keyd.stop();
    }
  });
});

// keyd/internal/oauthfixture: keyd's real admin, vault, listeners and broker, with a fake app behind
// them over TLS. Only the sign-in page itself is skipped: the code is the fake app's.
describe.skipIf(!KEYD_TESTS)("staying connected, through keyd to a fake app", () => {
  let dir: string;
  let home: string;
  let child: ChildProcess;
  let control: string;
  let hub: ConnectorHub;
  let signIn: ConnectorSignIn;
  let client: KeydClient;
  const pages: string[] = [];
  let links: RemoteLinks;

  const state = async () => (await (await fetch(`${control}/state`)).json()) as AppState;
  const entry = (): TaskConnectorTool => {
    const tool = hub.forTask().get("fake__whoami");
    if (!tool) throw new Error("the app's tool isn't on the task's list");
    return tool;
  };
  const call = () => hub.call(entry(), {}, AbortSignal.timeout(20_000));
  const until = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const approve = async () => {
    const page = new URL(pages.at(-1) ?? "");
    await signIn.finish(page.searchParams.get("state") ?? "", "the-code");
  };

  // The service's discovery, which keyd takes no part in, answered in memory.
  const discovery: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (init?.method === "POST") return new Response("", { status: 401 });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({ resource: APP, authorization_servers: [AUTH] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/authorize`,
        token_endpoint: `${AUTH}/token`,
        revocation_endpoint: `${AUTH}/revoke`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
      });
    return new Response("", { status: 404 });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ld-oauth-"));
    const binary = join(dir, "fixture");
    execFileSync(
      process.env.GO ?? "go",
      ["build", "-tags", "localdot_acceptance", "-o", binary, "./internal/oauthfixture"],
      { cwd: KEYD_DIR, stdio: ["ignore", "ignore", "inherit"] },
    );
    home = mkdtempSync(`/tmp/ld-oauth-${process.pid}-`);
    child = spawn(
      binary,
      [
        "-home",
        home,
        "-ports",
        `${TEST_KEYD_PORTS.from}-${TEST_KEYD_PORTS.to}`,
        "-lifetime",
        String(LIFETIME_S),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    control = await new Promise<string>((resolve, reject) => {
      let said = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        said += chunk.toString();
        const ready = /keyd ready socket=\S+ control=(\S+)/.exec(said);
        if (ready?.[1]) resolve(ready[1]);
      });
      child.once("exit", () => reject(new Error(`the fixture stopped:\n${said}`)));
    });
    client = new KeydClient(keydSocketPath(home));
    let next = TEST_KEYD_PORTS.from;
    links = new RemoteLinks({
      keyd: client,
      ports: {
        reserve: () => (next > TEST_KEYD_PORTS.to ? TEST_KEYD_PORTS.from : next++),
        release: () => {},
      },
    });
    hub = new ConnectorHub({
      store: new ConnectorStore(join(dir, "home")),
      links: new CellAndRemoteLinks({ remote: links }),
      keys: () => client.secrets(),
    });
    signIn = new ConnectorSignIn({
      hub,
      keyd: client,
      fetchFor: async () => ({ fetch: discovery, close: async () => {} }),
      open: async (url) => {
        pages.push(url);
        return true;
      },
    });
    hub.add({
      id: "fake",
      name: "Fake",
      server: { kind: "remote", url: APP, transport: "http", auth: { kind: "oauth" } },
    });
  });

  afterAll(async () => {
    await hub?.close();
    child?.kill("SIGTERM");
    if (home) rmSync(home, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("redeems the sign-in in keyd: the daemon gets a record and no token", async () => {
    await signIn.start("fake", "http://127.0.0.1:4750", false);
    await approve();
    await vi.waitFor(async () => expect((await hub.view("fake"))?.status).toBe("ready"), {
      timeout: 20_000,
    });
    const view = await hub.view("fake");
    expect(view?.account).toBe("ada@example.test");
    expect(view?.tools.map((tool) => tool.name)).toEqual(["whoami"]);
    const secrets = await client.secrets();
    expect(secrets.find((s) => s.id === "connector-fake")?.oauth).toMatchObject({
      refreshes: true,
      account: "ada@example.test",
    });
    const seen = [
      JSON.stringify(secrets),
      readFileSync(join(home, "keyd", "secrets.json"), "utf8"),
      readFileSync(join(home, "keyd", "audit.jsonl"), "utf8"),
      readFileSync(join(dir, "home", "connectors.json"), "utf8"),
    ].join("\n");
    expect(seen).not.toContain("fake-access-token");
    expect(seen).not.toContain("fake-refresh-token");
    expect(seen).not.toContain("the-code");
  });

  it("injects the token at the app and scrubs it from what the app says back", async () => {
    const outcome = await call();
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^your token is ld_/);
    expect(outcome.text).not.toContain("fake-access-token");
    expect((await state()).calls?.at(-1)).toBe("fake-access-token-1");
  });

  it("refreshes by itself when the token nears its end, without the daemon knowing", async () => {
    await until(LIFETIME_S * 1000);
    const cell = await client.cell("connector-fake");
    const surrogate = cell?.surrogates?.[0]?.surrogateId;
    const outcome = await call();
    expect(outcome.ok).toBe(true);
    const after = await state();
    expect(after.refreshes).toBe(1);
    expect(after.calls?.at(-1)).toBe("fake-access-token-2");
    expect(outcome.text).not.toContain("fake-access-token");
    expect((await client.cell("connector-fake"))?.surrogates?.[0]?.surrogateId).toBe(surrogate);
  });

  it("rotates again and refreshes once however many ask at once", async () => {
    await until(LIFETIME_S * 1000);
    const before = (await state()).refreshes;
    const outcomes = await Promise.all([call(), call(), call(), call()]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const after = await state();
    expect(after.refreshes).toBe(before + 1);
    expect(after.refused).toBe(0);
  });

  it("asks to reconnect once the app ends the sign-in, and a new sign-in restores it", async () => {
    await fetch(`${control}/control?revoke=1`, { method: "POST" });
    await until(LIFETIME_S * 1000);
    const outcome = await call();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("Reconnect");
    let view = await hub.view("fake");
    expect(view?.status).toBe("needs_sign_in");
    expect((await client.secrets()).find((s) => s.id === "connector-fake")?.oauth?.reconnect).toBe(
      true,
    );
    // With the app's key in keyd, the sign-in comes back through a listener that holds it.
    await signIn.start("fake", "http://127.0.0.1:4750", false);
    await approve();
    await vi.waitFor(async () => expect((await hub.view("fake"))?.status).toBe("ready"), {
      timeout: 20_000,
    });
    view = await hub.view("fake");
    expect(view?.problem).toBeUndefined();
    expect((await call()).ok).toBe(true);
  });

  it("revokes at the app and forgets everything on disconnect", async () => {
    await client.deleteSecret("connector-fake");
    await vi.waitFor(async () => expect((await state()).revoked).toBe(true));
    expect(await client.renewOAuth("connector-fake")).toBe("reconnect");
    expect((await client.secrets()).some((s) => s.id === "connector-fake")).toBe(false);
  });

  it("lets a listener reach a host a key is bound to only when it holds the key", async () => {
    await signIn.start("fake", "http://127.0.0.1:4750", false);
    await approve();
    const held = await links.signIn("fake", "connector-fake");
    expect((await client.cell("connector-fake-signin"))?.intercepts).toEqual([
      "mcp.fake-app.example.test",
    ]);
    await held.close();
  });
});
