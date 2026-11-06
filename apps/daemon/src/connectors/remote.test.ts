import type { RemoteServer } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { KeydClient } from "../keyd/client.ts";
import { type FakeKeyd, startFakeKeyd } from "../keyd/testing/fake-keyd.ts";
import { ConnectorProblem } from "./problem.ts";
import { keyHeader, RemoteLinks } from "./remote.ts";

const REAL_KEY = "lin_api_real_value_never_seen_here";
const record = (format: string, hosts = ["mcp.linear.app"]) => ({
  id: "connector-linear",
  kind: "http" as const,
  hosts,
  header: "authorization",
  format,
  createdAt: "t",
  updatedAt: "t",
});

describe("keyHeader", () => {
  it("puts the stand-in where the key's binding says, for the server's host only", () => {
    expect(keyHeader(record("bearer"), "mcp.linear.app", "ld_x")).toEqual({
      name: "authorization",
      value: "Bearer ld_x",
    });
    expect(keyHeader(record("raw"), "mcp.linear.app", "ld_x").value).toBe("ld_x");
    expect(() => keyHeader(record("bearer", ["api.linear.app"]), "mcp.linear.app", "ld_x")).toThrow(
      ConnectorProblem,
    );
    expect(() => keyHeader(record("basic-user"), "mcp.linear.app", "ld_x")).toThrow(
      ConnectorProblem,
    );
  });
});

describe("RemoteLinks", () => {
  let keyd: FakeKeyd;
  afterEach(async () => keyd?.close());

  const server: RemoteServer = {
    kind: "remote",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    auth: { kind: "key", secret: "connector-linear" },
  };

  async function links(answers: Response[] = []) {
    keyd = await startFakeKeyd();
    const sent: { url: string; headers: Headers; dispatcher: unknown; body?: unknown }[] = [];
    const ports = new Set<number>();
    const remote = new RemoteLinks({
      keyd: new KeydClient(keyd.socketPath, 1000),
      ports: {
        reserve: () => {
          ports.add(4780);
          return 4780;
        },
        release: (port) => ports.delete(port),
      },
      fetch: (async (url: URL, init: { headers: Headers; dispatcher: unknown; body?: unknown }) => {
        sent.push({
          url: String(url),
          headers: init.headers,
          dispatcher: init.dispatcher,
          body: init.body,
        });
        return (
          answers.shift() ?? new Response("{}", { headers: { "content-type": "application/json" } })
        );
      }) as never,
    });
    return { remote, sent, ports };
  }

  it("reaches its own host through its keyd listener with the key's stand-in, never the key", async () => {
    const { remote, sent, ports } = await links();
    keyd.records.set("connector-linear", record("bearer"));
    const link = await remote.open("linear", server);
    const cell = keyd.cells.get("connector-linear");
    expect(cell?.role).toBe("connector");
    await link.fetch("https://mcp.linear.app/mcp", { method: "POST", body: "{}" });
    const surrogate = cell?.surrogates["connector-linear"];
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${surrogate}`);
    expect(JSON.stringify(sent)).not.toContain(REAL_KEY);
    expect(sent[0]?.dispatcher).toBeDefined();
    await expect(link.fetch("https://evil.example/mcp")).rejects.toThrow("its own address");
    await expect(link.fetch("http://mcp.linear.app/mcp")).rejects.toThrow("its own address");
    await link.close();
    expect(keyd.cells.has("connector-linear")).toBe(false);
    expect(ports.size).toBe(0);
  });

  it("asks for the key, or a sign-in, before opening anything", async () => {
    const { remote } = await links();
    await expect(remote.open("linear", server)).rejects.toMatchObject({ status: "needs_key" });
    await expect(
      remote.open("notion", { ...server, auth: { kind: "oauth" } }),
    ).rejects.toMatchObject({ status: "needs_sign_in" });
    expect(keyd.cells.size).toBe(0);
  });

  describe("a signed-in app", () => {
    const signedIn: RemoteServer = {
      ...server,
      auth: { kind: "oauth", secret: "connector-linear" },
    };
    const refused = (headers: Record<string, string> = {}) =>
      new Response("no", { status: 401, headers });

    it("is asked once more, with the same stand-in, when it refuses a token keyd then renews", async () => {
      const { remote, sent } = await links([refused()]);
      keyd.records.set("connector-linear", record("bearer"));
      const link = await remote.open("linear", signedIn);
      const reply = await link.fetch("https://mcp.linear.app/mcp", { method: "POST", body: "{}" });
      expect(reply.status).toBe(200);
      expect(keyd.renewals).toEqual(["connector-linear"]);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.body).toBe("{}");
      expect(sent[1]?.headers.get("authorization")).toBe(sent[0]?.headers.get("authorization"));
      await link.close();
    });

    it("isn't asked again when keyd says the sign-in has ended", async () => {
      const { remote, sent } = await links([refused()]);
      keyd.renewal = "reconnect";
      keyd.records.set("connector-linear", record("bearer"));
      const link = await remote.open("linear", signedIn);
      const reply = await link.fetch("https://mcp.linear.app/mcp", { method: "POST", body: "{}" });
      expect(reply.status).toBe(401);
      expect(sent).toHaveLength(1);
      await link.close();
    });

    it("keeps a connection from before keyd refreshed: its 401 asks for a sign-in", async () => {
      const { remote, sent } = await links([refused()]);
      keyd.renewal = "none";
      keyd.records.set("connector-linear", record("bearer"));
      const link = await remote.open("linear", signedIn);
      const reply = await link.fetch("https://mcp.linear.app/mcp", { method: "POST", body: "{}" });
      expect(reply.status).toBe(401);
      expect(sent).toHaveLength(1);
      await link.close();
    });

    it("isn't renewed for keyd's own refusal", async () => {
      const { remote } = await links([refused({ "x-keyd-reason": "oauth-reconnect" })]);
      keyd.records.set("connector-linear", record("bearer"));
      const link = await remote.open("linear", signedIn);
      await link.fetch("https://mcp.linear.app/mcp", { method: "POST", body: "{}" });
      expect(keyd.renewals).toEqual([]);
      await link.close();
    });

    it("reports a sign-in service that is down, not a sign-in that ended", async () => {
      const { remote } = await links([refused()]);
      keyd.renewal = "unavailable";
      keyd.records.set("connector-linear", record("bearer"));
      const link = await remote.open("linear", signedIn);
      const reply = await link.fetch("https://mcp.linear.app/mcp", { method: "POST", body: "{}" });
      expect(reply.status).toBe(503);
      expect(await reply.text()).toContain("oauth-unavailable");
      await link.close();
    });

    it("never renews an app with a key of its own", async () => {
      const { remote, sent } = await links([refused()]);
      keyd.records.set("connector-linear", record("bearer"));
      const link = await remote.open("linear", server);
      const reply = await link.fetch("https://mcp.linear.app/mcp", { method: "POST", body: "{}" });
      expect(reply.status).toBe(401);
      expect(keyd.renewals).toEqual([]);
      expect(sent).toHaveLength(1);
      await link.close();
    });

    it("needs reconnecting before anything is opened once keyd says so", async () => {
      const { remote } = await links();
      keyd.records.set("connector-linear", { ...record("bearer"), oauth: { reconnect: true } });
      await expect(remote.open("linear", signedIn)).rejects.toMatchObject({
        status: "needs_sign_in",
      });
      expect(keyd.cells.size).toBe(0);
    });
  });

  it("holds an app's key while it signs in again, because keyd guards that host", async () => {
    const { remote } = await links();
    keyd.records.set("connector-linear", record("bearer"));
    const again = await remote.signIn("linear", "connector-linear");
    expect(keyd.cells.get("connector-linear-signin")?.secrets).toEqual(["connector-linear"]);
    await again.close();
    const fresh = await remote.signIn("linear", "connector-gone");
    expect(keyd.cells.get("connector-linear-signin")?.secrets).toEqual([]);
    await fresh.close();
  });

  it("opens a keyless listener for a sign-in, to any https host", async () => {
    const { remote, sent } = await links();
    const link = await remote.signIn("notion");
    expect(keyd.cells.get("connector-notion-signin")?.surrogates).toEqual({});
    await link.fetch("https://auth.notion.example/.well-known/oauth-authorization-server");
    expect(sent[0]?.headers?.get?.("authorization") ?? null).toBeNull();
    await expect(link.fetch("http://auth.notion.example/")).rejects.toThrow("https");
    await link.close();
  });
});
