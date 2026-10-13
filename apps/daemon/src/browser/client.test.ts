import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { BrowserClient, type BrowserScope } from "./client.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const send = (response: ServerResponse, value: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

async function fixture(handle?: (request: IncomingMessage, response: ServerResponse) => void) {
  let endpoint: ReadyBrowser;
  const seen: { path: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    if (handle) return handle(request, response);
    send(response, {
      browserCellId: endpoint.browserCellId,
      parentCellId: endpoint.parentCellId,
      instance: endpoint.instance,
      ready: true,
      holder: "user",
      width: 1280,
      height: 800,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port missing");
  endpoint = {
    browserCellId: ulid(),
    parentCellId: ulid(),
    instance: randomUUID(),
    browserd: { baseUrl: `http://127.0.0.1:${address.port}`, token: "s".repeat(43) },
    stream: { baseUrl: "http://127.0.0.1:4444", authorization: "fixture" },
  };
  const client = new BrowserClient(endpoint);
  cleanup.push(() => client.close());
  const abort = new AbortController();
  const scope: BrowserScope = { signal: abort.signal, check: vi.fn() };
  const id = {
    browserCellId: endpoint.browserCellId,
    parentCellId: endpoint.parentCellId,
    instance: endpoint.instance,
  };
  const permit = {
    ...id,
    revision: 1,
    requestId: ulid(),
    owner: { sessionId: ulid(), generation: 1 },
  };
  return { client, endpoint, id, seen, scope, abort, permit, tab: randomUUID() };
}

const typeRequest = {
  text: "A中",
  masked: false,
  pace: { firstCount: 1, firstMs: 0, restMs: 0 },
  injector: "xtest" as const,
};
const typeResult = { done: true, count: 2, firstPressMono: 1, armedMono: 0, injector: "xtest" };

describe("daemon browser client", () => {
  it("reads cookie domains and signs out of a site, refusing a reply that carries more", async () => {
    let body = "";
    let reply: unknown = { domains: [{ domain: "google.com", count: 2 }] };
    const f = await fixture((request, response) => {
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () =>
        send(response, request.url === "/accounts/sign-out" ? { cookies: 2 } : reply),
      );
    });
    expect(await f.client.cookieDomains(f.scope)).toEqual([{ domain: "google.com", count: 2 }]);
    expect(await f.client.signOut("google.com", f.scope)).toBe(2);
    expect(JSON.parse(body)).toEqual({ site: "google.com" });
    expect(f.seen.map((entry) => entry.path)).toEqual(["/accounts/cookies", "/accounts/sign-out"]);
    reply = { domains: [{ domain: "google.com", count: 2, value: "secret" }] };
    await expect(f.client.cookieDomains(f.scope)).rejects.toThrow("could not be read");
  });

  it("sends only the private manual permit and accepts count-only confirmations", async () => {
    let body: unknown;
    const f = await fixture((request, response) => {
      const bytes: Buffer[] = [];
      request.on("data", (chunk) => bytes.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(bytes).toString());
        send(response, { kind: "text", receipt: typeResult });
      });
    });
    const { owner: _, ...manual } = f.permit;
    expect(await f.client.manual(manual, { kind: "text", text: "A中" }, f.scope)).toEqual({
      kind: "text",
      receipt: typeResult,
    });
    expect(body).toEqual({ permit: manual, request: { kind: "text", text: "A中" } });
    expect(f.seen[0]).toEqual({
      path: "/manual",
      authorization: `Bearer ${f.endpoint.browserd.token}`,
    });
    await expect(
      f.client.manual({ ...manual, parentCellId: ulid() }, { kind: "text", text: "A中" }, f.scope),
    ).rejects.toThrow();
    expect(f.seen).toHaveLength(1);
  });

  it.each([
    { kind: "text", receipt: { ...typeResult, count: 1 } },
    { kind: "text", receipt: { ...typeResult, text: "private" } },
    { kind: "text", receipt: { ...typeResult, firstPressMono: -1 } },
    { kind: "input", receipt: { injector: "xtest", armedMono: 0, pressMono: 1, presses: [1] } },
  ])("rejects unconfirmed or over-disclosing manual replies %#", async (reply) => {
    const f = await fixture((_request, response) => send(response, reply));
    const { owner: _, ...manual } = f.permit;
    await expect(f.client.manual(manual, { kind: "text", text: "A中" }, f.scope)).rejects.toThrow();
  });
  it("bounds page replies and validates the admitted read request before transport", async () => {
    let reply: unknown = {
      url: "https://example.test/",
      title: "Page",
      text: "Below viewport",
      outline: "heading Details",
      truncated: false,
    };
    const bodies: unknown[] = [];
    const f = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        send(response, reply);
      });
    });
    expect(await f.client.read(f.permit, f.tab, {}, f.scope)).toEqual(reply);
    expect(bodies).toEqual([{ permit: f.permit, tabId: f.tab, request: { maxChars: 20000 } }]);
    reply = { ...(reply as object), text: "x".repeat(100001) };
    await expect(f.client.read(f.permit, f.tab, {}, f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "reply" }),
    );
    const count = f.seen.length;
    expect(() => f.client.read(f.permit, f.tab, { maxChars: 100001 }, f.scope)).toThrow();
    expect(f.seen).toHaveLength(count);
  });
  it("validates target and timing replies and carries the exact action authority", async () => {
    let reply: unknown = { target: null, window: null, ms: 1 };
    const bodies: unknown[] = [];
    const f = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        send(response, reply);
      });
    });
    expect(await f.client.lookup(f.permit, f.tab, { kind: "focused" }, f.scope)).toEqual(reply);
    expect(bodies[0]).toEqual({ permit: f.permit, tabId: f.tab, request: { kind: "focused" } });
    reply = { mono: 123 };
    expect(await f.client.clock(f.permit, f.tab, f.scope)).toEqual(reply);
    reply = { changed: [], lastChangeMono: null, quiet: true, noVisibleChange: true };
    expect(await f.client.settle(f.permit, f.tab, {}, f.scope)).toEqual(reply);
    expect(bodies[2]).toEqual({
      permit: f.permit,
      tabId: f.tab,
      request: { kind: "settle", request: { quietMs: 250, firstMs: 1500, timeoutMs: 3000 } },
    });
    reply = { mono: -1 };
    await expect(f.client.clock(f.permit, f.tab, f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "reply" }),
    );
    const count = f.seen.length;
    expect(() =>
      f.client.lookup({ ...f.permit, revision: 0 }, f.tab, { kind: "focused" }, f.scope),
    ).toThrow();
    expect(f.seen).toHaveLength(count);
  });
  it("pins localhost identity and authentication without exposing or retaining mutable endpoint data", async () => {
    const f = await fixture();
    f.endpoint.browserd.token = "mutated";
    expect((await f.client.health(f.scope)).browserCellId).toBe(f.id.browserCellId);
    expect(f.seen).toEqual([{ path: "/health", authorization: `Bearer ${"s".repeat(43)}` }]);
    expect(f.scope.check).toHaveBeenCalled();
  });

  it.each([
    "http://example.com:5000",
    "http://127.0.0.1:5000/path",
    "http://user@127.0.0.1:5000",
    "https://127.0.0.1:5000",
    "http://127.0.0.1:99999",
  ])("rejects noncanonical destinations before any request: %s", async (baseUrl) => {
    const f = await fixture();
    f.endpoint.browserd.baseUrl = baseUrl;
    expect(() => new BrowserClient(f.endpoint)).toThrow();
    expect(f.seen).toEqual([]);
  });

  it.each([
    [409, "secret_refused"],
    [422, "login_form"],
  ])(
    "reports password refusal %s without claiming the browser is offline",
    async (status, code) => {
      const f = await fixture((_request, response) => {
        response.writeHead(Number(status), { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "private-password-canary" }));
      });
      await expect(
        f.client.secret(
          f.permit,
          f.tab,
          { origin: "https://github.com", at: { x: 400, y: 300 } },
          f.scope,
        ),
      ).rejects.toThrow(expect.objectContaining({ code }));
    },
  );

  it.each([
    [409, "refused"],
    [423, "protected_input"],
    [503, "unavailable"],
  ])("distinguishes observation refusal %s from transport failure", async (status, code) => {
    const f = await fixture((_request, response) => {
      response.writeHead(Number(status), { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "private-canary" }));
    });
    await expect(f.client.read(f.permit, f.tab, { maxChars: 20000 }, f.scope)).rejects.toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("never follows a service redirect or reflects its private error text", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1:1/stolen" });
      response.end("private-token-body");
    });
    await expect(f.client.health(f.scope)).rejects.toThrow(
      /^The browser control connection is unavailable; the page may still be responsive\.$/,
    );
    expect(f.seen).toHaveLength(1);
  });

  it("refuses cross-instance health and mismatched control receipts", async () => {
    let reply: unknown;
    const f = await fixture((_request, response) => send(response, reply));
    reply = {
      ...f.id,
      instance: randomUUID(),
      ready: true,
      holder: "user",
      width: 1280,
      height: 800,
    };
    await expect(f.client.health(f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "stale" }),
    );
    const { owner: _owner, ...controlId } = f.permit;
    reply = { ...controlId, revision: 2, holder: "agent", reloaded: 0, selectionsCleared: true };
    await expect(f.client.control({ ...f.permit, holder: "agent" }, f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "stale" }),
    );
    reply = { ...controlId, holder: "agent", reloaded: 1, selectionsCleared: true };
    expect((await f.client.control({ ...f.permit, holder: "agent" }, f.scope)).reloaded).toBe(1);
  });

  it("rejects a mismatched action permit and revoked scope before sending", async () => {
    const f = await fixture();
    expect(() => f.client.observe({ ...f.permit, parentCellId: ulid() }, f.tab, f.scope)).toThrow(
      expect.objectContaining({ code: "stale" }),
    );
    f.scope.check = () => {
      throw new Error("private session details");
    };
    await expect(f.client.health(f.scope)).rejects.toThrow(
      /^The web browser or the selected screen changed during the request\.$/,
    );
    expect(f.seen).toEqual([]);
  });

  it("revalidates scope after a delayed reply and rejects response overflow", async () => {
    let allowed = true;
    const f = await fixture((_request, response) => {
      allowed = false;
      send(response, { tabs: [] });
    });
    f.scope.check = () => {
      if (!allowed) throw new Error("fenced");
    };
    await expect(f.client.tabs(f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "stale" }),
    );
    const huge = await fixture((_request, response) => send(response, "x".repeat(5000)));
    await expect(huge.client.health(huge.scope)).rejects.toThrow(
      expect.objectContaining({ code: "reply" }),
    );
  });

  it("parses a bounded browser observation and strict tab list", async () => {
    let reply: unknown;
    const f = await fixture((_request, response) => send(response, reply));
    reply = { tabs: [{ id: f.tab, ready: true }] };
    expect((await f.client.tabs(f.scope)).tabs[0]?.id).toBe(f.tab);
    reply = {
      frame: {
        frameId: ulid(),
        width: 1280,
        height: 800,
        image: "fixture-frame",
        pointer: { x: 0, y: 0 },
        windows: [],
      },
      targets: [],
    };
    expect((await f.client.observe(f.permit, f.tab, f.scope)).frame.width).toBe(1280);
    reply = { tabs: [{ id: f.tab, ready: true, cookie: "private" }] };
    await expect(f.client.tabs(f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "reply" }),
    );
  });

  it("consumes fragmented typing progress without returning typed text", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"kind":"pro');
      response.write('gress","count":1,"pressMono":1}\n');
      response.write('{"kind":"progress","count":2,"pressMono":2}\n');
      response.end(`${JSON.stringify({ kind: "result", result: typeResult })}\n`);
    });
    const progress = vi.fn();
    expect(await f.client.type(f.permit, f.tab, typeRequest, f.scope, progress)).toEqual(
      typeResult,
    );
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenNthCalledWith(1, { count: 1, pressMono: 1 });
    expect(progress).toHaveBeenNthCalledWith(2, { count: 2, pressMono: 2 });
  });

  it.each(
    [
      [{ kind: "progress", count: 1, pressMono: 1, chunk: "private-typed-text" }],
      [
        { kind: "progress", count: 1, pressMono: 1 },
        { kind: "progress", count: 1, pressMono: 2 },
      ],
      [{ kind: "result", result: { ...typeResult, count: 1 } }],
      [
        { kind: "progress", count: 2, pressMono: 2 },
        { kind: "result", result: typeResult },
        { kind: "progress", count: 2, pressMono: 2 },
      ],
      [{ kind: "error", code: "refused", detail: "private" }],
    ].map((events) => ({ events })),
  )(
    "refuses malformed/stale typing streams without disclosing response text: %j",
    async ({ events }) => {
      const f = await fixture((_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
      });
      await expect(f.client.type(f.permit, f.tab, typeRequest, f.scope, () => {})).rejects.toThrow(
        /^The web browser sent a reply that could not be read\.$/,
      );
    },
  );

  it("cancels a stalled progress consumer and closes transport", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"kind":"progress","count":1,"pressMono":1}\n');
    });
    await expect(
      f.client.type(f.permit, f.tab, typeRequest, f.scope, () => {
        f.abort.abort();
        return new Promise(() => {});
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "aborted" }));
  });

  it("terminal client close cancels an admitted request and prevents another", async () => {
    let cancel = () => {};
    const f = await fixture(() => cancel());
    cancel = () => f.client.close();
    await expect(f.client.health(f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "aborted" }),
    );
    await expect(f.client.health(f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "aborted" }),
    );
    expect(f.seen).toHaveLength(1);
  });

  it("correlates Stop and permanently closes after its confirmed receipt", async () => {
    let reply: unknown;
    const f = await fixture((_request, response) => send(response, reply));
    reply = { ...f.id, stopped: true };
    await f.client.stop(f.scope);
    await expect(f.client.health(f.scope)).rejects.toThrow(
      expect.objectContaining({ code: "aborted" }),
    );
  });
});
