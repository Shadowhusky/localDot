import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { connect, createServer } from "node:net";
import { serve } from "@hono/node-server";
import { ulid } from "@localdot/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { EventLog } from "./event-log.ts";
import { sessionStreamRoute } from "./event-stream.ts";
import { WS_TOKEN_PREFIX } from "./guard.ts";
import { RemoteLinks } from "./remote/links.ts";
import { attachUpgradeRouter, refuse, type UpgradeRoute } from "./upgrade-router.ts";

const TOKEN = "u".repeat(43);
const TICKET = "T".repeat(22);
const TOKEN_PROTOCOL = `Sec-WebSocket-Protocol: localdot.v1, ${WS_TOKEN_PREFIX}${TOKEN}`;
const OPENED = "HTTP/1.1 200 OK";
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

let stop: (() => void) | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  stop?.();
});

async function start(routes: UpgradeRoute[]): Promise<number> {
  const port = await freePort();
  const server = serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(server as Server, { port, token: TOKEN }, routes);
  await new Promise((r) => server.once("listening", r));
  stop = () => server.close();
  return port;
}

// Answers with the status line the server sends back; a Host line in `headers` replaces the default.
const upgrade = (port: number, target: string, headers: string[] = []) =>
  new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("data", (chunk) => {
      resolve(String(chunk).split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("close", () => resolve(""));
    const host = headers.some((h) => /^host:/i.test(h)) ? [] : [`Host: 127.0.0.1:${port}`];
    socket.write(
      [
        `GET ${target} HTTP/1.1`,
        ...host,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
        "",
        "",
      ].join("\r\n"),
    );
  });

function spyRoute(pattern: RegExp, params: string[], auth: UpgradeRoute["auth"]) {
  const opened: Record<string, string>[] = [];
  const route: UpgradeRoute = {
    pattern,
    params,
    auth,
    open(ctx) {
      opened.push(ctx.params);
      refuse(ctx.socket, "200 OK");
    },
  };
  return { route, opened };
}

const desktopPattern = /^\/cells\/([^/]+)\/desktop\/([^/]+)\/ws$/;

describe("upgrade router", () => {
  it("refuses a token route without the install token before its handler runs", async () => {
    const { route, opened } = spyRoute(/^\/token\/([^/]+)$/, ["id"], "token");
    const port = await start([route]);
    const refusals = [
      [],
      [`Sec-WebSocket-Protocol: localdot.v1, ${WS_TOKEN_PREFIX}${"x".repeat(43)}`],
      ["Sec-WebSocket-Protocol: localdot.v1"],
      [`Cookie: localdot_session=${TOKEN}`],
    ];
    for (const headers of refusals) {
      expect(await upgrade(port, "/token/a", headers)).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(await upgrade(port, `/token/a?token=${TOKEN}`)).toBe("HTTP/1.1 403 Forbidden");
    expect(opened).toEqual([]);
    expect(await upgrade(port, "/token/a", [TOKEN_PROTOCOL])).toBe(OPENED);
    expect(opened).toEqual([{ id: "a" }]);
  });

  it("checks Host and Origin before any route and leaves a ticket route to authorise itself", async () => {
    const { route, opened } = spyRoute(desktopPattern, ["id", "ticket"], "ticket");
    const port = await start([route]);
    const path = `/cells/C/desktop/${TICKET}/ws`;
    const foreign = [
      ["Origin: http://evil.com"],
      ["Origin: null"],
      ["Host: evil.com"],
      [`Host: 127.0.0.1:${port + 1}`],
    ];
    for (const headers of foreign) {
      expect(await upgrade(port, path, [TOKEN_PROTOCOL, ...headers])).toBe(
        "HTTP/1.1 403 Forbidden",
      );
    }
    expect(await upgrade(port, `http://evil.com${path}`)).toBe("HTTP/1.1 403 Forbidden");
    expect(opened).toEqual([]);
    expect(await upgrade(port, path, [`Origin: http://127.0.0.1:${port}`])).toBe(OPENED);
    expect(opened).toEqual([{ id: "C", ticket: TICKET }]);
  });

  it("answers 404 when no route matches, with or without the token", async () => {
    const { route, opened } = spyRoute(/^\/token$/, [], "token");
    const port = await start([route]);
    expect(await upgrade(port, "/nope")).toBe("HTTP/1.1 404 Not Found");
    expect(await upgrade(port, "/nope", [TOKEN_PROTOCOL])).toBe("HTTP/1.1 404 Not Found");
    expect(opened).toEqual([]);
  });

  it("answers 500 when a route throws, logs only the route's pattern and keeps serving", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: UpgradeRoute = {
      pattern: desktopPattern,
      params: ["id", "ticket"],
      auth: "ticket",
      open({ url }) {
        throw Object.assign(new Error(`cannot open ${url.pathname}`), { code: "EACCES" });
      },
    };
    const { route, opened } = spyRoute(/^\/ok$/, [], "ticket");
    const port = await start([failing, route]);
    const status = await upgrade(port, `/cells/C/desktop/${TICKET}/ws`);
    expect(status).toBe("HTTP/1.1 500 Internal Server Error");
    expect(errors.mock.calls).toEqual([[expect.stringContaining("EACCES")]]);
    expect(String(errors.mock.calls[0]?.[0])).toContain(String(desktopPattern));
    expect(String(errors.mock.calls[0]?.[0])).not.toContain(TICKET);
    expect(await upgrade(port, "/ok")).toBe(OPENED);
    expect(opened).toHaveLength(1);
  });

  it("writes no request path, ticket or token to the console", async () => {
    const methods = ["debug", "error", "info", "log", "trace", "warn"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const tokenRoute = spyRoute(/^\/token$/, [], "token");
    const ticketRoute = spyRoute(desktopPattern, ["id", "ticket"], "ticket");
    const port = await start([tokenRoute.route, ticketRoute.route]);
    const path = `/cells/C/desktop/${TICKET}/ws`;
    expect(await upgrade(port, path)).toBe(OPENED);
    expect(await upgrade(port, path, ["Origin: http://evil.com"])).toBe("HTTP/1.1 403 Forbidden");
    expect(await upgrade(port, `${path}/x`, [TOKEN_PROTOCOL])).toBe("HTTP/1.1 404 Not Found");
    expect(await upgrade(port, "/token", [TOKEN_PROTOCOL])).toBe(OPENED);
    expect(await upgrade(port, "/token")).toBe("HTTP/1.1 403 Forbidden");
    expect(await upgrade(port, "http://[/x")).toBe("HTTP/1.1 400 Bad Request");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

it("names none of the owner's keys to a guest's live feed", async () => {
  const home = mkdtempSync("/tmp/localdot-guest-feed-");
  const links = new RemoteLinks(home);
  const issued = links.create({
    label: "Guest",
    expiresInHours: null,
    maxTasks: 1,
    model: { provider: "openai", model: "gpt-6.1-sol" },
  });
  const eventLog = new EventLog(home);
  const id = eventLog.createSession("task");
  const raise = (key: string) =>
    eventLog.append(id, {
      type: "blocker.raise",
      agent: "main",
      data: {
        blockerId: ulid(),
        blocker: { kind: "key", id: key, problem: "rejected" },
        by: "localdot",
      },
    });
  raise("private-early");
  links.showing(() => [id]);
  const port = await freePort();
  const server = serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(
    server as Server,
    { port, token: TOKEN, guests: { links, authenticate: (token) => links.authenticate(token) } },
    [sessionStreamRoute(eventLog)],
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const heard = async (token: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/stream`, [
      "localdot.v1",
      `${WS_TOKEN_PREFIX}${token}`,
    ]);
    const got: string[] = [];
    socket.on("message", (data) => got.push(String(data)));
    await new Promise((resolve) => socket.once("open", resolve));
    return { socket, got };
  };
  const guest = await heard(issued.token);
  const owner = await heard(TOKEN);
  try {
    raise("private-late");
    await vi.waitFor(() => {
      expect(guest.got).toHaveLength(2);
      expect(owner.got).toHaveLength(2);
    });
    expect(guest.got.join("")).not.toContain("private-");
    expect(owner.got.join("")).toContain("private-early");
    expect(owner.got.join("")).toContain("private-late");
  } finally {
    guest.socket.close();
    owner.socket.close();
    server.close();
    eventLog.close();
    links.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("opens a task's live feed to a link only for its own task or the one the owner's app shows", async () => {
  const home = mkdtempSync("/tmp/localdot-guest-ws-");
  const links = new RemoteLinks(home);
  const issued = links.create({
    label: "Guest",
    expiresInHours: null,
    maxTasks: 1,
    model: { provider: "openai", model: "gpt-6.1-sol" },
  });
  const own = "01JXYZ0000000000000000AAA1",
    shown = "01JXYZ0000000000000000BBB2",
    theirs = "01JXYZ0000000000000000CCC3";
  links.reserve(issued.grant.id).finish(own);
  let showing: string | null = null;
  const { route, opened } = spyRoute(/^\/api\/sessions\/([^/]+)\/stream$/, ["id"], "token");
  const port = await freePort();
  const server = serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(
    server as Server,
    { port, token: TOKEN, guests: { links, authenticate: (token) => links.authenticate(token) } },
    [route],
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const guest = `Sec-WebSocket-Protocol: localdot.v1, ${WS_TOKEN_PREFIX}${issued.token}`;
  try {
    expect(await upgrade(port, `/api/sessions/${theirs}/stream`, [guest])).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(await upgrade(port, `/api/sessions/${theirs.toLowerCase()}/stream`, [guest])).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(await upgrade(port, `/api/sessions/${shown}/stream`, [guest])).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(opened).toEqual([]);
    expect(await upgrade(port, `/api/sessions/${own}/stream?fromSeq=4`, [guest])).toBe(OPENED);
    links.showing(() => (showing ? [showing] : []));
    showing = shown;
    expect(await upgrade(port, `/api/sessions/${shown}/stream`, [guest])).toBe(OPENED);
    showing = null;
    expect(await upgrade(port, `/api/sessions/${shown}/stream`, [guest])).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(await upgrade(port, `/api/sessions/${theirs}/stream`, [TOKEN_PROTOCOL])).toBe(OPENED);
    expect(opened).toEqual([{ id: own }, { id: shown }, { id: theirs }]);
  } finally {
    server.close();
    links.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("disconnects an already-open guest socket immediately on revocation, preserving the owner's socket", async () => {
  const home = mkdtempSync("/tmp/localdot-guest-ws-");
  const links = new RemoteLinks(home);
  const issued = links.create({
    label: "Guest",
    expiresInHours: null,
    maxTasks: 1,
    model: { provider: "openai", model: "gpt-6.1-sol" },
  });
  const port = await freePort();
  const server = serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port });
  const sockets: import("node:stream").Duplex[] = [];
  attachUpgradeRouter(
    server as Server,
    { port, token: TOKEN, guests: { links, authenticate: (token) => links.authenticate(token) } },
    [
      {
        pattern: /^\/api\/cells\/([0-9A-Z]{26})\/status$/,
        params: ["id"],
        auth: "token",
        open({ socket }) {
          sockets.push(socket);
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
          );
        },
      },
    ],
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const open = (token: string) =>
    new Promise<import("node:net").Socket>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("data", () => resolve(socket));
      socket.write(
        `GET /api/cells/01JXYZ0000000000000000CE11/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: localdot.v1, ${WS_TOKEN_PREFIX}${token}\r\n\r\n`,
      );
    });
  const guest = await open(issued.token),
    owner = await open(TOKEN);
  try {
    const closed = new Promise((resolve) => guest.once("close", resolve));
    links.revoke(issued.grant.id);
    await closed;
    expect(guest.destroyed).toBe(true);
    expect(owner.destroyed).toBe(false);
    expect(sockets[1]?.destroyed).toBe(false);
  } finally {
    guest.destroy();
    owner.destroy();
    for (const socket of sockets) socket.destroy();
    server.close();
    links.close();
    rmSync(home, { recursive: true, force: true });
  }
});
